import lodepng from '@cwasm/lodepng'
import rotate from 'rotate-image-data'

/**
 * @param {Uint8Array} data
 * @param {boolean} rotate180
 * @returns {Uint8Array}
 */
export function convertStarprntToPng (data, rotate180 = false) {
  if (data[0] !== 0x1b || data[1] !== 0x1d || data[2] !== 0x53 || data[3] !== 0x01 || data[8] !== 0x00) {
    throw new Error('Unimplemented StarPRNT data')
  }

  const height = data[6] + (data[7] << 8)
  const widthBytes = data[4] + (data[5] << 8)
  const width = widthBytes * 8

  const pixelData = new Uint8Array(width * height * 4)

  for (let outPtr = 0, inPtr = (9 * 8); outPtr < pixelData.length; inPtr++) {
    const pixel = (data[(inPtr / 8) | 0] >> (7 - (inPtr % 8))) & 1 ? 0 : 255
    pixelData[outPtr++] = pixel
    pixelData[outPtr++] = pixel
    pixelData[outPtr++] = pixel
    pixelData[outPtr++] = 255
  }

  let imageData = { data: pixelData, width, height }

  if (rotate180) {
    imageData = rotate(imageData, 180)
  }

  return lodepng.encode(imageData)
}
