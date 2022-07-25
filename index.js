#!/usr/bin/env node

import { writeFileSync } from 'fs'
import neodoc from 'neodoc'
import fetch from 'node-fetch'
import { setTimeout } from 'timers/promises'

const usage = `
CloudPRNT Emulator

usage:
  cloudprnt-emulator <poll-url> [options]

options:
  <poll-url>                   A URL that the client will poll regularly through an http POST.
  --help                       Show this help, then exit.
  --poll-interval=INTERVAL     The client will connect to the server at this interval to provide the server with live status updates, and check for print jobs or client action requests [default: 5].
  --username=USERNAME          The username to use when connecting to the server ( optional ).
  --password=PASSWORD          The password to use when connecting to the server ( optional ).
`

/**
 * @param {URL} url
 * @returns {Promise<{ jobReady: boolean, jobToken?: string, mediaTypes?: string[] }>}
 */
async function post(url, customBody = false, user = false, pass = false) {
  let body = {
    printingInProgress: false,
    statusCode: '200%20OK',
    printerMAC: '00:11:62:00:00:00',
    status: '21 6 0 0 0 0 0 0 0',
  }

  if (customBody !== false) {
    body = Object.assign(body, customBody)
  }

  const args = { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, method: 'POST' }

  if (user && pass) {
    args.headers.Authorization = 'Basic ' + Buffer.from(user + ":" + pass).toString('base64')
  }

  const response = await fetch(url, args)

  if (!response.ok) {
    throw new Error(`POST request to ${url} failed: ${response.status} ${response.statusText}`)
  }

  return await response.text().then(function (text) {
    return text ? JSON.parse(text) : {}
  })
}

/**
 * @param {URL} url
 * @param {string} [jobToken]
 * @returns {Promise<Buffer>}
 */
async function get(url, jobToken, user = false, pass = false) {
  const newUrl = new URL(url)
  newUrl.searchParams.append('type', 'text/plain')
  newUrl.searchParams.append('mac', '00:11:62:00:00:00')
  if (jobToken) newUrl.searchParams.append('token', jobToken)

  const args = { method: 'GET' }

  if (user && pass) {
    args.headers = {
      'Authorization': 'Basic ' + Buffer.from(user + ":" + pass).toString('base64')
    }
  }

  const response = await fetch(newUrl, args)

  if (!response.ok) {
    throw new Error(`GET request to ${newUrl} failed: ${response.status} ${response.statusText}`)
  }

  return await response.arrayBuffer()
}

/**
 * @param {URL} url
 * @param {string} code
 * @param {string} [jobToken]
 * @returns {Promise<void>}
 */
async function delete_(url, code, jobToken, user = false, pass = false) {
  const newUrl = new URL(url)
  newUrl.searchParams.append('code', code)
  newUrl.searchParams.append('mac', '00:11:62:00:00:00')
  if (jobToken) {
    newUrl.searchParams.append('token', jobToken)
  }

  const args = { method: 'DELETE' }

  if (user && pass) {
    args.headers = {
      'Authorization': 'Basic ' + Buffer.from(user + ":" + pass).toString('base64')
    }
  }

  const response = await fetch(newUrl, args)

  if (!response.ok) {
    throw new Error(`DELETE request to ${newUrl} failed: ${response.status} ${response.statusText}`)
  }
}

try {
  const args = neodoc.run(usage, { laxPlacement: true })
  const delay = Number.parseInt(args['--poll-interval']) * 1000
  const user = args['--username'] || false
  const pass = args['--password'] || false
  const url = new URL(args['<poll-url>'])

  if (!Number.isSafeInteger(delay)) {
    throw new Error(`Invalid poll interval: ${args['--poll-interval']}`)
  }

  while (true) {
    try {
      const status = await post(url, false, user, pass)

      if (!status.jobReady) {
        if (typeof status.clientAction !== "undefined" && status.clientAction.length > 0) {
          let data = { clientAction: [] }
          for (let i = 0; i < status.clientAction.length; i++) {
            if (typeof status.clientAction[i].request !== "undefined") {
              switch (status.clientAction[i].request) {
                case 'GetPollInterval':
                  data.clientAction.push({ request: 'GetPollInterval', result: delay })
                  break;
                case 'Encodings':
                  data.clientAction.push({ request: 'Encodings', result: 'text/plain' })
                  break;
                case 'ClientType':
                  data.clientAction.push({ request: 'ClientType', result: 'Star Printer Emulator' })
                  break;
                case 'ClientVersion':
                  data.clientAction.push({ request: 'ClientVersion', result: 'HIX' })
                  break;
              }
            }
          }
          await post(url, data, user, pass)
        }
        await setTimeout(delay)
        continue
      }

      let code = '500'

      try {
        if (status.mediaTypes && !status.mediaTypes.includes('text/plain')) {
          code = '510'
          throw new Error(`Unsupported media types: ${status.mediaTypes}`)
        }

        const data = await get(url, status.jobToken, user, pass)
        writeFileSync(`print-${new Date().toISOString().replace(/:/g, '.')}.txt`, Buffer.from(data))
        code = '200'
      } finally {
        await delete_(url, code, status.jobToken, user, pass)
      }
    } catch (error) {
      console.error(`${error}`)
      await setTimeout(delay)
    }
  }
} catch (error) {
  process.exitCode = 1
  console.error(error.stack)
}
