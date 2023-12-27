import type { DuplexOptions } from 'readable-stream'

declare interface IConfig extends RTCConfiguration {
  iceServers: { urls: string; username?: string; credential?: string }[]
  sdpSemantics: 'unified-plan'
}

declare interface IOptions extends DuplexOptions {
  allowHalfOpen?: boolean
  initiator?: boolean
  channelName?: string
  // predefined id
  id?: string
  channelConfig?: ChannelConfig
  config?: IConfig
  offerOptions?: RTCOfferOptions
  answerOptions?: RTCAnswerOptions
  streams?: any[]
  sdpTransform?: Function
  iceCompleteTimeout?: EpochTimeStamp
  allowHalfTrickle?: boolean
  trickle?: boolean
}

export declare type ChannelConfig = {
  negotiated: boolean
}

export declare type Options = IOptions
export declare type Config = IConfig
