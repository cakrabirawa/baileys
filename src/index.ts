import 'dotenv/config'
import express from "express"
import WaService from './services/whatsapp/index'
import cors from "cors"
import QRCode from 'qrcode'
import dotenv from "dotenv"
import parsePhoneNumber, { isValidPhoneNumber } from 'libphonenumber-js'
import { Attachment, ConnectionState } from './services/whatsapp/type'
import { replaceHtmlEntities, timeout, renameFileAsync } from './utils'
import { body, validationResult } from "express-validator"
import { createLogger, format, transports } from 'winston'
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { deleteOldTempRemoteFile } from './utils'
import * as cron from 'node-cron';
import * as fs from 'fs/promises'; // Use promises for async operations
import * as path from 'path';

dotenv.config()
const PORT = process.env.PORT || 3934
const app = express()
const multer = require('multer')
const upload = multer({ 
	dest: 'tmp/',	 
})
const compression = require('compression')
const { combine, timestamp, prettyPrint, colorize, errors, } = format
const credBaseDir = 'wa-auth-creds'
const qrCodeBasedir = './wa-bots/qr-codes'
const DIRECTORY_TO_CLEAN = './tmp'; // Specify your target directory
// const SEVEN_DAYS_IN_MS = 1 * 24 * 60 * 60 * 1000; // One Day in milliseconds
const SEVEN_DAYS_IN_MS = 3 * 60 * 60 * 1000; // Umur file > 3 jam

// type DestinationCallback = (error: Error | null, destination: string) => void
// type FileNameCallback = (error: Error | null, filename: string) => void

const logger = createLogger({
	format: combine(
		errors({ stack: true }),
		colorize(),
		timestamp(),
		prettyPrint()
	),
	transports: [
		new transports.Console(),
		new transports.File({ filename: 'application.log' }),
	],
})
interface waServiceClassMap<T extends WaService> {
	[key: string]: T
}
let waServiceClass: waServiceClassMap<WaService> | undefined = {}
const initWaServer = (stateId: string): Promise<void> => {
	return new Promise(async (resolve) => {
		await waServiceClass[stateId].connect()
		waServiceClass[stateId].on(`service.whatsapp.qr`, async (value) => {
			if (!await existsSync(qrCodeBasedir)) {
				await mkdirSync(qrCodeBasedir, { recursive: true })
			}
			await writeFileSync(`${qrCodeBasedir}/qr-code-${waServiceClass[stateId].getCredId()}.txt`, value.qr.toString())
		})
		await timeout(6000)
		resolve()
	})
}
// const fileStorage = multer.diskStorage({
// 	destination: (
// 			request: Request,
// 			file: Express.Multer.File,
// 			callback: DestinationCallback
// 	): void => {
// 			// ...Do your stuff here.
// 	},

// 	filename: (
// 			req: Request, 
// 			file: Express.Multer.File, 
// 			callback: FileNameCallback
// 	): void => {
// 			// ...Do your stuff here.
// 	}
// })
const runExpressServer = async () => {
	app.use(express.urlencoded({ extended: true })); // support encoded bodies
	app.use(compression());
	app.use(cors())
	app.use(express.json())
	app.listen(PORT, () => {
		logger.info(`Whatsapp api app listening on port ${PORT}`)
	})
	app.use(async (req, res, next) => {
		if (req.query?.cred_id) {
			const stateId = req.query.cred_id.toString()
			if (!waServiceClass[stateId]) {
				waServiceClass[stateId] = new WaService(stateId)
				waServiceClass[stateId].setCredBaseDir(credBaseDir)
				try {
					await waServiceClass[stateId].checkConnection()
				} catch (e) {
					if (typeof e === 'string' && e === 'waiting for connection') {
						await initWaServer(stateId)
					}
				}
			}
		} else {
			return res.status(400).json({ status: 400, message: "cred_id is required" }).end()
		}
		next()
	})
	app.get('/delete-temp-files', (req, res) => {
		if (req.query.cred_id) {
			const stateId = req.query.cred_id.toString()
			if (!waServiceClass[stateId]) {
				return res.status(400).json({ status: 400, message: "connection uninitialized" }).end()
			}
			deleteOldTempRemoteFile(stateId)
			res.json({ status: 100, message: "delete on progress" }).end()
		}
	})
	app.get('/logout', async (req, res) => {
		if (req.query.cred_id) {
			const stateId = req.query.cred_id.toString()
			if (!waServiceClass[stateId]) {
				return res.status(400).json({ status: 100, message: "connection uninitialized" }).end()
			}
			try {
				await waServiceClass[stateId].checkConnection()
				waServiceClass[stateId].disconnect()
			} catch (error) {
				logger.info(error)
			}
			await timeout(3000)
			deleteOldTempRemoteFile(stateId)
			res.json({ status: 100, message: "success logout" }).end()
		}
	})
	app.get('/restart-web-socket', async (req, res) => {
		if (req.query.cred_id) {
			const stateId = req.query.cred_id.toString()
			if (!waServiceClass[stateId]) {
				return res.status(400).json({ status: 400, message: "connection uninitialized" }).end()
			}
			try {
				waServiceClass[stateId].restartWebSocket()
			} catch (error) {
				logger.info(error)
			}
			res.json({ status: 100, message: "success restart web socket" }).end()
		}
	})
	app.get('/restart', async (req, res) => {
		if (req.query.cred_id) {
			const stateId = req.query.cred_id.toString()
			if (!waServiceClass[stateId]) {
				return res.status(400).json({ status: 400, message: "connection uninitialized" }).end()
			}
			try {
				waServiceClass[stateId].disconnect(true)
			} catch (error) {
				logger.info(error)
			}
			await timeout(3000)
			try {
				await waServiceClass[stateId].forceReset()
			} catch (error) {
				logger.info(error)
			}
			await initWaServer(stateId)
			res.json({ status: 100, message: "success restart" }).end()
		}
	})
	app.get('/get-qrcode', async (req, res) => {
		if (req.query.cred_id) {
			const stateId = req.query.cred_id.toString()
			if (!waServiceClass[stateId]) {
				return res.status(400).json('connection uninitialized')
			}

			try {
				await waServiceClass[stateId].checkConnection()
				res.json({ status: 100, message: "connected" }).end()
				return
			} catch (e) {
			}

			let qrCodeString: string = ''
			try {
				qrCodeString = await readFileSync(`${qrCodeBasedir}/qr-code-${waServiceClass[stateId].getCredId()}.txt`, 'utf-8')
			} catch (err) {
				console.error(err)
				res.json({ status: 100, message: "qr code not available" }).end()
				return
			}

			try {
				qrCodeString = await QRCode.toDataURL(qrCodeString)
				res.setHeader("Content-Type", "application/json")
				res.json({ qrbase64: qrCodeString, timestamp: new Date(), clientid: stateId }).end()
			} catch (err) {
				console.error(err)
				res.json({ status: 400, message: "failed to get qr code" }).end()
			}
		}
	})
	app.get('/get-state', async (req, res) => {
		if (req.query.cred_id) {
			const stateId = req.query.cred_id.toString()
			if (!waServiceClass[stateId]) {
				return res.status(400).json('connection uninitialized')
			}
			if (await waServiceClass[stateId].getState() === ConnectionState.idle) {
				await waServiceClass[stateId].initializeConnection()
				await timeout(5000)
			}
			try {
				await waServiceClass[stateId].checkConnection()
				res.json({ status: 100, message: "connected" }).end()
			} catch (e) {
				console.error('error get state', e)
				return res.status(400).json(typeof e === 'string' ? e : 'failed check connection').end()
			}
		}
	})
	app.post('/send-text-message', body('phone_number').notEmpty().escape(), body('message').notEmpty().escape(), async (req, res) => {
		// @ts-ignore
		const stateId = req.query.cred_id.toString()
		if (!waServiceClass[stateId]) {
			return res.status(400).json('connection uninitialized')
		}
		const errors = validationResult(req)
		if (!errors.isEmpty()) {
			return res.status(400).json({ errors: errors.array() })
		}
		const phoneNumber = isValidPhoneNumber(req.body.phone_number, 'ID') ? parsePhoneNumber(req.body.phone_number, 'ID') : null
		if (phoneNumber) {
			req.body.phone_number = phoneNumber.number.toString().replace("+", "")
		} else {
			return res.status(400).json({
				errors: [
					{
						value: req.body.phone_number,
						msg: 'Invalid phone number',
						param: 'phone_number',
						location: 'body'
					}
				]
			})
		}
		if (await waServiceClass[stateId].getState() === ConnectionState.idle) {
			await waServiceClass[stateId].initializeConnection()
			await timeout(5000)
		}
		try {
			await waServiceClass[stateId].checkConnection()
			await waServiceClass[stateId].sendTextMessage(req.body.phone_number, replaceHtmlEntities(req.body.message))
			res.json({ status: 100, message: "success" }).end()
		} catch (e) {
			logger.info(e)
			if (e === 'waiting for connection') {
				return res.status(400).json('please wait a second')
			} else if (e === 'no active connection found') {
				return res.status(400).json('please scan barcode')
			} else if (e === 'number not exists') {
				return res.status(400).json('number not exists')
			}
			// @ts-ignore
			if (e && e.message && e.message === 'Connection Closed') {
				logger.info('masuk kondisi Connection Closed')
				await waServiceClass[stateId].initializeConnection()
			}
			res.status(500).json('failed send message').end()
		}
	})
	app.post('/send-media-message', body('phone_number').notEmpty().escape(), body('message').escape(), body('media_url').notEmpty(), async (req, res) => {
		// @ts-ignore
		const stateId = req.query.cred_id.toString()
		if (!waServiceClass[stateId]) {
			return res.status(400).json('connection uninitialized')
		}
		const errors = validationResult(req)
		if (!errors.isEmpty()) {
			return res.status(400).json({ errors: errors.array() })
		}
		const phoneNumber = isValidPhoneNumber(req.body.phone_number, 'ID') ? parsePhoneNumber(req.body.phone_number, 'ID') : null
		if (phoneNumber) {
			req.body.phone_number = phoneNumber.number.toString().replace("+", "")
		} else {
			return res.status(400).json({
				errors: [
					{
						value: req.body.phone_number,
						msg: 'Invalid phone number',
						param: 'phone_number',
						location: 'body'
					}
				]
			})
		}
		try {
			await waServiceClass[stateId].checkConnection()
			let message = ''
			if (req.body.message) {
				message = replaceHtmlEntities(req.body.message)
			}
			const url = req.body.media_url
			const name = url.toString().split("/")
			const media: Attachment = {
				url: url,
				name: name[name.length - 1],
				filesize: 0,
				type: 'photo'
			}
			waServiceClass[stateId].sendMediaMessage(req.body.phone_number, media, message)
			res.json({ status: 100, message: "success" }).end()
		} catch (e) {
			logger.info(e)
			if (e === 'waiting for connection') {
				return res.status(400).json({ status: 400, message: "please wait a second" }).end()
			} else if (e === 'no active connection found') {
				return res.status(400).json({ status: 400, message: "please scan barcode" }).end()
			} else if (e === 'number not exists') {
				return res.status(400).json({ status: 400, message: "number not exists" }).end()
			}
			res.status(500).json('failed send message').end()
		}
	})
	app.post('/send-media-message-upload', upload.single('file'), body('phone_number').notEmpty().escape(), body('message').escape(), async (req, res) => {
		// @ts-ignore
		const stateId = req.query.cred_id.toString()
		// @ts-ignore
		const old_file = "./tmp/" + req.file.filename, new_file = "./tmp/" + req.file.originalname
		await renameFileAsync(old_file, new_file).then(async () => {
			const pNumber = req.body.phone_number;
			// @ts-ignore
			if (!waServiceClass[stateId]) {
				return res.status(400).json({ status: 400, message: "connection uninitialized" }).end()
			}
			const errors = validationResult(req)
			if (!errors.isEmpty()) {
				return res.status(400).json({ errors: errors.array() })
			}
			const phoneNumber = isValidPhoneNumber(pNumber, 'ID') ? parsePhoneNumber(pNumber, 'ID') : null
			if (phoneNumber) {
				req.body.phone_number = phoneNumber.number.toString().replace("+", "")
			} else {
				return res.status(400).json({
					errors: [
						{
							value: req.body.phone_number,
							msg: 'Invalid phone number',
							param: 'phone_number',
							location: 'body'
						}
					]
				}).end()
			}
			try {
				await waServiceClass[stateId].checkConnection()
				let message = ''
				if (req.body.message) {
					message = replaceHtmlEntities(req.body.message)
				}
				const media: Attachment = {
					url: new_file,
					name: new_file,
					filesize: 0,
					type: 'photo'
				}
				waServiceClass[stateId].sendMediaMessageUpload(req.body.phone_number, media, message)
				res.json({ status: 100, message: "success" }).end()
			} catch (e) {
				logger.info(e)
				if (e === 'waiting for connection') {
					return res.status(400).json({ status: 400, message: "please wait a second" }).end()
				} else if (e === 'no active connection found') {
					return res.status(400).json({ status: 400, message: "please scan barcode" }).end()
				} else if (e === 'number not exists') {
					return res.status(400).json({ status: 400, message: "number not exists" }).end()
				}
				res.status(500).json('failed send message').end()
			}
		})
	})
	app.post('/upload', upload.single('file'), async (req, res) => {
		// @ts-ignore
		const original_file_name = req.file.originalname.toString();
		// @ts-ignore
		const ext = original_file_name.split(".")[original_file_name.split(".").length - 1]
		// @ts-ignore
		const old_file = "./tmp/" + req.file.filename, new_file = "./tmp/" + req.file.filename + "." + ext 
		await renameFileAsync(old_file, new_file).then(async () => {
			try {
				res.json({ status: 100, message: "upload success", filename: new_file }).end()
			} catch (e) {
				logger.info(e)
				res.status(500).json({status: 500, message: "upload failed send message"}).end()
			}
		})
	})
	app.post('/send-media-message-after-upload', body('phone_number').notEmpty().escape(), body('message').escape(), body('file_name').notEmpty().escape(), async (req, res) => {
		// @ts-ignore
		const stateId = req.query.cred_id.toString()
		const pNumber = req.body.phone_number
		const file_name = req.body.file_name
		const tmp = "tmp\\"
		// @ts-ignore
		if (!waServiceClass[stateId]) {
			return res.status(400).json({ status: 400, message: "connection uninitialized" }).end()
		}
		const errors = validationResult(req)
		if (!errors.isEmpty()) {
			return res.status(400).json({ errors: errors.array() })
		}
		const phoneNumber = isValidPhoneNumber(pNumber, 'ID') ? parsePhoneNumber(pNumber, 'ID') : null
		if (phoneNumber) {
			req.body.phone_number = phoneNumber.number.toString().replace("+", "")
		} else {
			return res.status(400).json({
				errors: [
					{
						value: req.body.phone_number,
						msg: 'Invalid phone number',
						param: 'phone_number',
						location: 'body'
					}
				]
			}).end()
		}
		try {
			await waServiceClass[stateId].checkConnection()
			let message = ''
			if (req.body.message) {
				message = replaceHtmlEntities(req.body.message)
			}
			const media: Attachment = {
				url: tmp + file_name,
				name: tmp + file_name,
				filesize: 0,
				type: 'photo'
			}
			waServiceClass[stateId].sendMediaMessageUpload(req.body.phone_number, media, message)
			res.json({ status: 100, message: "success" }).end()
		} catch (e) {
			logger.info(e)
			if (e === 'waiting for connection') {
				return res.status(400).json({ status: 400, message: "please wait a second" }).end()
			} else if (e === 'no active connection found') {
				return res.status(400).json({ status: 400, message: "please scan barcode" }).end()
			} else if (e === 'number not exists') {
				return res.status(400).json({ status: 400, message: "number not exists" }).end()
			}
			res.status(500).json('failed send message').end()
		}
	})	
}
const cronAutoCleanUpAttachment = cron.schedule('0 0 */3 * * *', async () => { // Setiap 3 jam hapus file upload nya
	console.log('Running file cleanup job...');
	try {
		const files = await fs.readdir(DIRECTORY_TO_CLEAN);
		for (const file of files) {
			const filePath = path.join(DIRECTORY_TO_CLEAN, file);
			const stats = await fs.stat(filePath);
			if (stats.isFile() && (Date.now() - stats.mtimeMs > SEVEN_DAYS_IN_MS)) {
				await fs.unlink(filePath);
				console.log(`Deleted old file: ${filePath}`);
			}
		}
		console.log('File cleanup job completed.');
	} catch (error) {
		console.error('Error during file cleanup:', error);
	}
});

cronAutoCleanUpAttachment
runExpressServer()
