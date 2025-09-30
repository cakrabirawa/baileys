import makeWASocket, { Browsers, DisconnectReason, useMultiFileAuthState, WASocket } from '@whiskeysockets/baileys';
import { readFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { Attachment, ConnectionState } from './type';
import { Boom } from '@hapi/boom'
import { EventEmitter } from 'events';
import { downloadTempRemoteFile } from './../../utils';
interface ConnectionObject {
  [key: string]: WASocket;
}
export default class WhatsApp extends EventEmitter {
  private connections: ConnectionObject;
  private credId: string;
  private credBaseDir: string = '';
  private state: ConnectionState;
  constructor(credId: string) {
    super();
    this.credId = credId;
    this.state = ConnectionState.idle;
    this.connections = {};
  }
  getCredId(): string {
    return this.credId
  }
  setCredBaseDir(credBaseDir: string): void {
    this.credBaseDir = credBaseDir;
  }
  getConnections(): { [key: string]: WASocket } {
    return this.connections;
  }
  findConnection(): WASocket | null {
    return this.connections[this.credId] ? this.connections[this.credId] : null;
  }
  setConnection(sock: WASocket): WASocket {
    return this.connections[this.credId] = sock;
  }
  restartWebSocket(): void {
    const conn = this.findConnection()
    if (conn) {
      this.setState(ConnectionState.idle)
      conn.end(new Error("restart"))
    }
  }
  async removeConnection(force = false): Promise<void> {
    if (this.connections[this.credId]) {
      if (force) {
        try {
          this.connections[this.credId].logout()
        } catch (e) { }
      } else {
        this.connections[this.credId].logout()
      }
      delete this.connections[this.credId]
      const dir = this.credBaseDir + '/' + this.credId;
      if (await existsSync(dir)) {
        await rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  forceReset(): Promise<null> {
    return new Promise(async (resolve) => {
      const dir = this.credBaseDir + '/' + this.getCredId();
      if (await existsSync(dir)) {
        await rmSync(dir, { recursive: true, force: true });
      }
      return resolve(null)
    });
  }
  async setState(state: ConnectionState) {
    if (state !== this.state) {
      this.state = state;
      this.triggerEvent('state', state);
    }
  }
  async getState(): Promise<ConnectionState> {
    return Promise.resolve(this.state);
  }
  private triggerEvent(eventName: string, value: any): void {
    this.emit(`service.whatsapp.${eventName}`, value);
  }
  async initializeConnection(): Promise<WASocket | null> {
    const dir = this.credBaseDir;
    if (!await existsSync(dir)) {
      await mkdirSync(dir, { recursive: true });
    }
    const { state, saveCreds } = await useMultiFileAuthState(`${dir}/` + this.credId)
    const sock = makeWASocket({
      syncFullHistory: true,
      browser: Browsers.windows('Desktop'),
      printQRInTerminal: false,
      auth: state,
      generateHighQualityLinkPreview: true,
      retryRequestDelayMs: 3000
    });
    console.log('run generateQR')
    this.generateQR(sock)
    sock.ev.on('creds.update', () => {
      saveCreds()
    })
    this.setConnection(sock)
    return this.findConnection()
  }
  async generateQR(sock: WASocket): Promise<string> {
    return new Promise((resolve) => {
      sock.ev.on('connection.update', async (update) => {
        console.log('update.connection ', update.connection)
        if (update.connection === 'close' && (update.lastDisconnect?.error as Boom)?.output?.statusCode === DisconnectReason.restartRequired) {
          await this.initializeConnection()
        } else if (update.connection === 'open') {
          this.setState(ConnectionState.connected)
        }
        if (update.qr) {
          this.setState(ConnectionState.disconnected)
          this.triggerEvent('qr', {
            qr: update.qr
          })
          resolve(update.qr)
        }
      })
    })
  }
  async connect(): Promise<WASocket | null> {
    return new Promise(async (resolve, reject) => {
      try {
        let sock = this.findConnection();
        if (!sock) {
          sock = await this.initializeConnection()
        }
        setTimeout(async () => {
          this.triggerEvent('state', await this.getState());
        }, 3000);
        resolve(sock)
      } catch (error) {
        reject(error)
      }
    });
  }
  async disconnect(force = false): Promise<null> {
    return new Promise((resolve, reject) => {
      try {
        this.removeConnection(force)
        resolve(null);
      } catch (error) {
        reject(error)
      }
    });
  }
  async checkConnection(): Promise<ConnectionState> {
    return new Promise(async (resolve, reject) => {
      try {
        const conn = this.findConnection()
        const state = await this.getState()
        if (state === ConnectionState.idle) {
          return reject('waiting for connection')
        }
        if (state === ConnectionState.disconnected || !conn) {
          return reject('no active connection found')
        }
        return resolve(state)
      } catch (error) {
        return reject(error)
      }
    })
  }
  async sendTextMessage(destinationNumber: string, messageContent: string): Promise<string> {
    return new Promise(async (resolve, reject) => {
      try {
        if (!destinationNumber || !messageContent) {
          return reject('missing required parameters')
        }
        const formattedRecipient = `${destinationNumber}@c.us`
        if (!/^[\d]+@c.us$/.test(formattedRecipient)) {
          return reject('invalid recipient format')
        }
        const conn = this.findConnection()
        const state = await this.getState()
        if (state === ConnectionState.idle) {
          return reject('waiting for connection')
        }
        if (state === ConnectionState.disconnected || !conn) {
          return reject('no active connection found')
        }
        // @ts-ignore
        const [result] = await conn.onWhatsApp(formattedRecipient)
        if (result.exists) {
        } else {
          return reject('number not exists')
        }
        await conn.sendMessage(formattedRecipient, { text: messageContent })
        return resolve(`success send message to ${formattedRecipient} with message ${messageContent}`)
      } catch (error) {
        return reject(error)
      }
    })
  }
  async sendMediaMessage(destinationNumber: string, file: Attachment, messageContent: string): Promise<string> {
    return new Promise(async (resolve, reject) => {
      try {
        if (!destinationNumber || !file || !file.url) {
          return reject('missing required parameters')
        }
        const formattedRecipient = `${destinationNumber}@c.us`
        if (!/^[\d]+@c.us$/.test(formattedRecipient)) {
          return reject('invalid recipient format')
        }
        const conn = this.findConnection()
        const state = await this.getState()
        if (state === ConnectionState.idle) {
          return reject('waiting for connection')
        }
        if (state === ConnectionState.disconnected || !conn) {
          return reject('no active connection found')
        }
        const [result] = await conn.onWhatsApp(formattedRecipient);
        if (!result.exists) {
          return reject('number not exists')
        }
        const savedFile = await downloadTempRemoteFile(this.getCredId(), file.url, file.name);
        if (file.type === 'photo') {
          await conn.sendMessage(formattedRecipient, {
            image: readFileSync(savedFile),
            caption: messageContent
          });
        }
        return resolve(`success send message to ${formattedRecipient} with media ${file.url}`)
      } catch (error) {
        return reject(error)
      }
    })
  }
  async sendMediaMessageUpload(destinationNumber: string, file: Attachment, messageContent: string): Promise<string> {
    return new Promise(async (resolve, reject) => {
      try {
        if (!destinationNumber || !file || !file.name) {
          return reject('missing required parameters')
        }
        const formattedRecipient = `${destinationNumber}@c.us`
        if (!/^[\d]+@c.us$/.test(formattedRecipient)) {
          return reject('invalid recipient format')
        }
        const conn = this.findConnection()
        const state = await this.getState()
        if (state === ConnectionState.idle) {
          return reject('waiting for connection')
        }
        if (state === ConnectionState.disconnected || !conn) {
          return reject('no active connection found')
        }
        const [result] = await conn.onWhatsApp(formattedRecipient);
        if (!result.exists) {
          return reject('number not exists')
        }
        if (file.type === 'photo') {
          await conn.sendMessage(formattedRecipient, {
            image: readFileSync(file.name),
            caption: messageContent
          });
        }
        return resolve(`success send message to ${formattedRecipient} with media ${file.name}`)
      } catch (error) {
        return reject(error)
      }
    })
  }
}