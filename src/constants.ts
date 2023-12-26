import { Config, Options } from './types.js'

export const DEFAULT_CHANNEL_CONFIG = {
  negotiated: false
}

export const DEFAULT_CONFIG: Config = {
  iceServers: [
    {
      urls: 'stun:stun.l.google.com:19302' // Google's public STUN server
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  sdpSemantics: 'unified-plan'
}

export const DEFAULT_OPTIONS: Options = {
  allowHalfOpen: false,
  allowHalfTrickle: false,
  trickle: true,
  streams: [],
  sdpTransform: (sdp) => sdp
}

export const MAX_BUFFERED_AMOUNT = 64 * 1024
export const ICECOMPLETE_TIMEOUT = 5 * 1000
export const CHANNEL_CLOSING_TIMEOUT = 5 * 1000
