#!/usr/bin/env node

import lodepng from '@cwasm/lodepng'
import rotate from 'rotate-image-data'
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
  --rotate180                  Rotate the image 180 degrees.
`

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
async function get (url, jobToken) {
  const newUrl = new URL(url)
  newUrl.searchParams.append('type', 'image/png')
  newUrl.searchParams.append('mac', '00:00:00:00:00:00')
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
  newUrl.searchParams.append('mac', '00:00:00:00:00:00')
  if (jobToken) newUrl.searchParams.append('token', jobToken)
  const response = await fetch(newUrl, { method: 'DELETE' })

  if (!response.ok) {
    throw new Error(`DELETE request to ${newUrl} failed: ${response.status} ${response.statusText}`)
  }
}

try {
  const args = neodoc.run(usage, { laxPlacement: true })
  const delay = Number.parseInt(args['--poll-interval']) * 1000
  const url = new URL(args['<poll-url>'])

  if (!Number.isSafeInteger(delay)) {
    throw new Error(`Invalid poll interval: ${args['--poll-interval']}`)
  }

  while (true) {
    try {
      const status = await post(url)

      if (!status.jobReady) {
        await setTimeout(delay)
        continue
      }

      let code = '500'

      try {
        if (status.mediaTypes && !status.mediaTypes.includes('image/png')) {
          code = '510'
          throw new Error(`Unsupported media types: ${status.mediaTypes}`)
        }

        let pngData = await get(url, status.jobToken)

        if (args['--rotate180']) {
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
} catch (error) {
  process.exitCode = 1
  console.error(error.stack)
}
