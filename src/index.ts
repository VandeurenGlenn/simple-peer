/*! simple-peer. MIT License. Feross Aboukhadijeh <https://feross.org/opensource> */
import '@vandeurenglenn/debug'
import {
  DEFAULT_CONFIG,
  DEFAULT_OPTIONS,
  DEFAULT_CHANNEL_CONFIG,
  MAX_BUFFERED_AMOUNT,
  ICECOMPLETE_TIMEOUT,
  CHANNEL_CLOSING_TIMEOUT
} from './constants.js'
import PeerInterface from './interface.js'
import type { Options } from './types.js'
/**
 * WebRTC peer connection. Same API as node core `net.Socket`, plus a few extra methods.
 * Duplex stream.
 * @param {Object} options
 */
export default class Peer extends PeerInterface {
  get id() {
    return this._id
  }

  address() {
    return {
      port: this.localPort,
      family: this.localFamily,
      address: this.localAddress
    }
  }

  signal(data) {
    if (this.destroying) return
    if (this.destroyed) throw new Error('cannot signal after peer is destroyed')
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data)
      } catch (err) {
        data = {}
      }
    }
    debug('signal()')

    if (data.renegotiate && this.initiator) {
      debug('got request to renegotiate')
      this._needsNegotiation()
    }
    if (data.transceiverRequest && this.initiator) {
      debug('got request for transceiver')
      this.addTransceiver(data.transceiverRequest.kind, data.transceiverRequest.init)
    }
    if (data.candidate) {
      if (this._pc.remoteDescription && this._pc.remoteDescription.type) {
        this._addIceCandidate(data.candidate)
      } else {
        this._pendingCandidates.push(data.candidate)
      }
    }
    if (data.sdp) {
      this._pc
        .setRemoteDescription(new RTCSessionDescription(data))
        .then(() => {
          if (this.destroyed) return

          this._pendingCandidates.forEach((candidate) => {
            this._addIceCandidate(candidate)
          })
          this._pendingCandidates = []

          if (this._pc.remoteDescription.type === 'offer') this._createAnswer()
        })
        .catch((err) => {
          this._destroy(err)
        })
    }
    if (!data.sdp && !data.candidate && !data.renegotiate && !data.transceiverRequest) {
      this._destroy(new Error('signal() called with invalid signal data'))
    }
  }

  /**
   * Send text/binary data to the remote peer.
   * @param {ArrayBufferView|ArrayBuffer|Buffer|string|Blob} chunk
   */
  send(message: Uint8Array, id = crypto.randomUUID()) {
    if (this.destroying) return
    if (this.destroyed) throw new Error('cannot send after peer is destroyed')
    if (!this.connected) return this._messagesToSend.push({ message, id, size: message.length })

    if (this._channel.bufferedAmount < MAX_BUFFERED_AMOUNT - 16000) {
      debug('sending')
      const chunk = message.slice(0, 16000)
      this._channel.send(JSON.stringify({ id, chunk, size: message.length }))
      this._messagesToSend.push({
        message: message.slice(16000, message.length),
        id,
        size: message.length
      })
    } else {
      this._messagesToSend.push({ message, id, size: message.length })
    }
  }
}
