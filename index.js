#!/usr/bin/env node

import lodepng from '@cwasm/lodepng'
import rotate from 'rotate-image-data'
import { writeFileSync } from 'fs'
import neodoc from 'neodoc'
import fetch from 'node-fetch'
import { setTimeout } from 'timers/promises'
import mqtt from 'mqtt'

import { convertStarprntToPng } from './lib/starprnt.js'

const PRINTER_MAC = '00:00:00:00:00:00'

const usage = `
CloudPRNT Emulator

usage:
  cloudprnt-emulator <poll-url> [options]

options:
  <poll-url>                   A URL that the client will poll regularly through an http POST.
  --help                       Show this help, then exit.
  --poll-interval=INTERVAL     The client will connect to the server at this interval to provide the server with live status updates, and check for print jobs or client action requests [default: 5].
  --rotate180                  Rotate the image 180 degrees.
`

/**
 * Get server settings from cloudprnt-setting.json endpoint
 * @param {URL} pollUrl - The original poll URL
 * @returns {Promise<{useMQTT: boolean, mqttSettings?: any}>}
 */
async function getServerSettings (pollUrl) {
  // Derive cloudprnt-setting.json endpoint by replacing the last path segment
  const settingsUrl = new URL(pollUrl)
  const pathSegments = settingsUrl.pathname.split('/').filter(Boolean)
  const originalLastSegment = pathSegments[pathSegments.length - 1] // Store the original last segment
  pathSegments[pathSegments.length - 1] = 'cloudprnt-setting.json'
  settingsUrl.pathname = '/' + pathSegments.join('/')

  // Add required query parameters
  settingsUrl.searchParams.append('mac', PRINTER_MAC)
  settingsUrl.searchParams.append('replaced_path', originalLastSegment)

  // Retry logic for 500-series errors and timeouts
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(settingsUrl, {
        method: 'GET',
        timeout: 15000 // 15 second timeout as per spec
      })

      if (response.status === 404) {
        // Server doesn't support MQTT, use HTTP polling
        return { useMQTT: false }
      }

      if (response.status === 200) {
        const settings = await response.json()
        return parseServerSettings(settings)
      }

      if (response.status >= 500) {
        // Server error, retry after 5 seconds
        if (attempt < 3) {
          await setTimeout(5000)
          continue
        }
        throw new Error(`Server error: ${response.status} ${response.statusText}`)
      }

      throw new Error(`Unexpected response: ${response.status} ${response.statusText}`)
    } catch (error) {
      if (attempt === 3) {
        throw error
      }
      // Timeout or network error, retry after 5 seconds
      await setTimeout(5000)
    }
  }
}

/**
 * Parse server settings response
 * @param {any} settings - Server settings JSON
 * @returns {{useMQTT: boolean, mqttSettings?: any}}
 */
function parseServerSettings (settings) {
  const serverSupportProtocol = settings.serverSupportProtocol || []
  const settingForMQTT = settings.settingForMQTT || {}

  // Check if server supports MQTT
  if (!serverSupportProtocol.includes('MQTT')) {
    return { useMQTT: false }
  }

  // Check if server wants Trigger POST mode (not supported)
  if (settingForMQTT.useTriggerPOST === true) {
    throw new Error('Server requires Trigger POST mode, which is not supported. Only Full MQTT mode is supported.')
  }

  // Use Full MQTT mode
  return {
    useMQTT: true,
    mqttSettings: settingForMQTT.mqttConnectionSetting
  }
}

/**
 * @param {URL} url
 * @returns {Promise<{ jobReady: boolean, jobToken?: string, mediaTypes?: string[] }>}
 */
async function post (url) {
  const body = JSON.stringify({ printingInProgress: false, statusCode: '200%20OK' })
  const response = await fetch(url, { body, headers: { 'Content-Type': 'application/json' }, method: 'POST' })

  if (!response.ok) {
    throw new Error(`POST request to ${url} failed: ${response.status} ${response.statusText}`)
  }

  return await response.json()
}

/**
 * @param {URL} url
 * @param {string} [jobToken]
 * @returns {Promise<Buffer>}
 */
async function get (url, jobToken, type) {
  const newUrl = new URL(url)
  newUrl.searchParams.append('type', type)
  newUrl.searchParams.append('mac', PRINTER_MAC)
  if (jobToken) newUrl.searchParams.append('token', jobToken)
  const response = await fetch(newUrl, { method: 'GET' })

  if (!response.ok) {
    throw new Error(`GET request to ${newUrl} failed: ${response.status} ${response.statusText}`)
  }

  return await response.buffer()
}

/**
 * @param {URL} url
 * @param {string} code
 * @param {string} [jobToken]
 * @returns {Promise<void>}
 */
async function delete_ (url, code, jobToken) {
  const newUrl = new URL(url)
  newUrl.searchParams.append('code', code)
  newUrl.searchParams.append('mac', PRINTER_MAC)
  if (jobToken) newUrl.searchParams.append('token', jobToken)
  const response = await fetch(newUrl, { method: 'DELETE' })

  if (!response.ok) {
    throw new Error(`DELETE request to ${newUrl} failed: ${response.status} ${response.statusText}`)
  }
}

/**
 * HTTP polling mode implementation
 * @param {URL} url - Poll URL
 * @param {number} delay - Poll interval in milliseconds
 * @param {boolean} rotate180 - Whether to rotate images 180 degrees
 */
async function runHttpPolling (url, delay, rotate180) {
  console.log('Starting HTTP polling mode...')

  while (true) {
    try {
      const status = await post(url)

      if (!status.jobReady) {
        await setTimeout(delay)
        continue
      }

      let code = '500'

      try {
        if (status.mediaTypes && !(status.mediaTypes.includes('application/vnd.star.starprnt') || status.mediaTypes.includes('image/png'))) {
          code = '510'
          throw new Error(`Unsupported media types: ${status.mediaTypes}`)
        }

        let pngData
        if (status.mediaTypes.includes('application/vnd.star.starprnt')) {
          pngData = convertStarprntToPng(await get(url, status.jobToken, 'application/vnd.star.starprnt'))
        } else {
          pngData = await get(url, status.jobToken, 'image/png')
        }

        if (rotate180) {
          let imageData = lodepng.decode(pngData)
          imageData = rotate(imageData, 180)
          pngData = lodepng.encode(imageData)
        }

        writeFileSync(`img-${new Date().toISOString().replace(/:/g, '.')}.png`, pngData)
        code = '200'
      } finally {
        await delete_(url, code, status.jobToken)
      }
    } catch (error) {
      console.error(`${error}`)
      await setTimeout(delay)
    }
  }
}

/**
 * MQTT mode implementation
 * @param {URL} pollUrl - Original poll URL for downloading print jobs
 * @param {any} mqttSettings - MQTT broker settings
 * @param {boolean} rotate180 - Whether to rotate images 180 degrees
 */
async function runMqttMode (pollUrl, mqttSettings, rotate180) {
  console.log('Starting MQTT mode...', mqttSettings)

  const host = mqttSettings.hostName
  const port = mqttSettings.portNumber || 1883
  const protocol = mqttSettings.useTls ? 'mqtts' : 'mqtt'
  const username = mqttSettings.authenticationSetting?.username
  const password = mqttSettings.authenticationSetting?.password

  console.log(`Connecting to MQTT broker: ${host}:${port}`)
  if (username) {
    console.log(`Using username: ${username}`)
  }

  const client = mqtt.connect({
    host,
    port,
    username,
    password,
    clientId: PRINTER_MAC,
    protocol,
    protocolVersion: 4, // MQTT v3.1.1
    clean: false,
    will: {
      topic: `star/cloudprnt/to-server/${PRINTER_MAC}/client-will`,
      payload: JSON.stringify({ title: 'client-will', printerMAC: PRINTER_MAC, unintentionalDisconnection: true }),
      qos: 1
    }
  })

  const deviceTopic = `star/cloudprnt/to-device/${PRINTER_MAC}/#`
  const serverTopicPrefix = `star/cloudprnt/to-server/${PRINTER_MAC}`

  return new Promise((resolve, reject) => {
    client.on('connect', () => {
      console.log('Connected to MQTT broker')

      // Subscribe to device messages
      client.subscribe(deviceTopic, { qos: 1 }, (err) => {
        if (err) {
          reject(err)
          return
        }
        console.log(`Subscribed to ${deviceTopic}`)
      })

      // Send initial status
      client.publish(`${serverTopicPrefix}/client-status`,
        JSON.stringify({ title: 'client-status', printerMAC: PRINTER_MAC, statusCode: '200%20OK', printingInProgress: false }),
        { qos: 1 })
      console.log('Initial status sent')
    })

    client.on('message', async (topic, message) => {
      try {
        console.log(`Received message on topic ${topic}`)
        const payload = JSON.parse(message.toString())
        await handleMqttMessage(payload, pollUrl, client, serverTopicPrefix, rotate180)
      } catch (error) {
        console.error('Error handling MQTT message:', error)
      }
    })

    client.on('error', (err) => {
      console.error('MQTT connection error:', err)
      reject(err)
    })

    client.on('close', () => {
      console.log('MQTT connection closed')
    })
  })
}

/**
 * Handle incoming MQTT messages
 * @param {any} payload - Message payload
 * @param {URL} pollUrl - Poll URL for downloading print jobs
 * @param {any} client - MQTT client
 * @param {string} serverTopicPrefix - Server topic prefix
 * @param {boolean} rotate180 - Whether to rotate images 180 degrees
 */
async function handleMqttMessage (payload, pollUrl, client, serverTopicPrefix, rotate180) {
  const { title } = payload

  if (title === 'print-job') {
    await handlePrintJob(payload, pollUrl, client, serverTopicPrefix, rotate180)
  } else {
    throw new Error(`Unsupported message type: ${title}`)
  }
}

/**
 * Handle print job message
 * @param {any} payload - Print job payload
 * @param {URL} pollUrl - Poll URL for downloading print jobs
 * @param {any} client - MQTT client
 * @param {string} serverTopicPrefix - Server topic prefix
 * @param {boolean} rotate180 - Whether to rotate images 180 degrees
 */
async function handlePrintJob (payload, pollUrl, client, serverTopicPrefix, rotate180) {
  const { jobToken, jobType, mediaTypes } = payload

  let statusCode = '500'

  try {
    // Send status: printing started
    await client.publishAsync(`${serverTopicPrefix}/client-status`,
      JSON.stringify({ title: 'client-status', printerMAC: PRINTER_MAC, statusCode: '200%20OK', printingInProgress: true }),
      { qos: 1 })

    if (jobType !== 'raw') {
      statusCode = '500'
      throw new Error(`Unsupported job type: ${jobType}`)
    }

    if (!mediaTypes || mediaTypes.length !== 1 || !mediaTypes.includes('application/vnd.star.starprnt')) {
      statusCode = '510'
      throw new Error(`Unsupported media types: ${mediaTypes}`)
    }

    const rawData = Buffer.from(payload.printData, 'base64')
    const pngData = convertStarprntToPng(rawData, rotate180)

    writeFileSync(`img-${new Date().toISOString().replace(/:/g, '.')}.png`, pngData)
    statusCode = '200'
  } finally {
    // Send print result
    await client.publishAsync(`${serverTopicPrefix}/print-result`,
      JSON.stringify({ title: 'print-result', jobToken, printSucceeded: statusCode.startsWith('200'), statusCode, printerMAC: PRINTER_MAC }),
      { qos: 1 })

    // Send status: printing finished
    await client.publishAsync(`${serverTopicPrefix}/client-status`,
      JSON.stringify({ title: 'client-status', printerMAC: PRINTER_MAC, statusCode: '200%20OK', printingInProgress: false }),
      { qos: 1 })
  }
}

try {
  const args = neodoc.run(usage, { laxPlacement: true })
  const delay = Number.parseInt(args['--poll-interval']) * 1000
  const url = new URL(args['<poll-url>'])
  const rotate180 = args['--rotate180']

  if (!Number.isSafeInteger(delay)) {
    throw new Error(`Invalid poll interval: ${args['--poll-interval']}`)
  }

  // Discover server protocol capabilities
  console.log('Discovering server protocol capabilities...')
  const serverSettings = await getServerSettings(url)

  if (serverSettings.useMQTT) {
    console.log('Server supports MQTT, starting MQTT mode')
    try {
      await runMqttMode(url, serverSettings.mqttSettings, rotate180)
    } catch (error) {
      console.error('MQTT mode failed, falling back to HTTP polling:', error)
      await runHttpPolling(url, delay, rotate180)
    }
  } else {
    console.log('Server does not support MQTT, using HTTP polling mode')
    await runHttpPolling(url, delay, rotate180)
  }
} catch (error) {
  process.exitCode = 1
  console.error(error.stack)
}
