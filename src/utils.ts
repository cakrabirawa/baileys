import axios from 'axios'
import { mkdirSync, existsSync, createWriteStream, readdirSync, statSync, unlinkSync, promises as fs_promises } from 'fs'
import { dirname, join } from 'path'

export function timeout(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
export function replaceHtmlEntities(input: string): string {
  const entities: { [key: string]: string } = {
    '&#x27': "'",
    '&amp#x27': "'",
    '&quot': '"',
    '&ampquot': '"',
    '&lt': '<',
    '&amplt': '<',
    '&gt': '>',
    '&ampgt': '>',
    '&nbsp': ' ',
    '&ampnbsp': ' ',
    '&copy': '©',
    '&ampcopy': '©',
    '&reg': '®',
    '&ampreg': '®',
    '&euro': '€',
    '&ampeuro': '€',
    '&amp#x2F': '/',
    '&#x2F': '/',
    '\\\\': '\\',
    '\/': '/',
    // '&amp': '&', // Uncomment this if you need to replace '&' as well
  }
  return input.replace(/&#x27|&amp#x27|&quot|&ampquot|&lt|&amplt|&gt|&ampgt|&nbsp|&ampnbsp|&copy|&ampcopy|&reg|&ampreg|&euro|&ampeuro|&amp#x2F|&#x2F|\\\\|\//g, match => entities[match])
}
export function downloadTempRemoteFile(credId: string, url: string, saveAs: string): Promise<string> {
  return new Promise(async (resolve, reject) => {
    // const destinationFile = `tmp/${credId}/` + saveAs
    const destinationFile = `tmp/` + saveAs
    if (await existsSync(destinationFile)) {
      return resolve(destinationFile)
    }
    const dir = dirname(destinationFile)
    if (!await existsSync(dir)) {
      await mkdirSync(dir, {
        recursive: true
      })
    }
    try {
    } catch (e) {
      return reject(e)
    }
    axios({
      method: 'get',
      url: url,
      responseType: 'stream'
    }).then(function (response) {
      response.data.pipe(
        createWriteStream(destinationFile)
          .on('finish', function () {
            setTimeout(() => {
              resolve(destinationFile)
            }, 500)
          }).on('error', e => reject(e))
      )
    }).catch(e => reject(e))
  })
}
export function deleteOldTempRemoteFile(credId: string): Promise<string> {
  return new Promise(async (resolve, reject) => {
    const oneHourAgo = Date.now() - 3600000
    const result = []
    const folderPath = `tmp/${credId}`
    try {
      const files = await readdirSync(folderPath)
      for (const file of files) {
        const filePath = join(folderPath, file)
        const stats = await statSync(filePath)
        if (stats.isFile() && stats.mtimeMs < oneHourAgo) {
          result.push(filePath)
        }
      }
    } catch (error) {
      reject(error)
    }
    try {
      if (result.length > 0) {
        for (const filePath of result) {
          await unlinkSync(filePath)
          console.log(`Deleted file: ${filePath}`)
        }
      }
    } catch (error) {
      reject(error)
    }
    resolve('success')
  })
}
export function renameFileAsync(oldPath: string, newPath: string): Promise<string> {
  return new Promise(async (resolve, reject) => {
    try {
      await fs_promises.rename(oldPath, newPath)
      console.log(`File '${oldPath}' successfully renamed to '${newPath}'.`)
    } catch (error) {
      reject(error)
    }
    resolve('success')
  })
}
