if (!globalThis.DEBUG) {
  if (globalThis.localStorage) globalThis.DEBUG = Boolean(globalThis.localStorage.getItem('DEBUG') === 'true');
}

globalThis.debug = text => {
  if (globalThis.DEBUG) console.log('\x1b[34m\x1b[1m%s', text, '\x1b[0m'); // bright blue
};

const DEFAULT_CHANNEL_CONFIG = {
    negotiated: false
};
const DEFAULT_CONFIG = {
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
};
const DEFAULT_OPTIONS = {
    allowHalfOpen: false,
    allowHalfTrickle: false,
    trickle: true,
    streams: [],
    sdpTransform: (sdp) => sdp
};
const MAX_BUFFERED_AMOUNT = 64 * 1024;
const ICECOMPLETE_TIMEOUT = 5 * 1000;
const CHANNEL_CLOSING_TIMEOUT = 5 * 1000;

class LittlePubSub {
    subscribers = {};
    verbose;
    constructor(verbose) {
        this.verbose = verbose;
    }
    _handleContext(handler, context) {
        if (typeof context === 'undefined') {
            context = handler;
        }
        return context;
    }
    hasSubscribers(event) {
        return this.subscribers[event] ? true : false;
    }
    subscribe(event, handler, context) {
        if (!this.hasSubscribers(event))
            this.subscribers[event] = { handlers: [], value: undefined };
        context = this._handleContext(handler, context);
        this.subscribers[event].handlers.push(handler.bind(context));
    }
    unsubscribe(event, handler, context) {
        if (!this.hasSubscribers(event))
            return;
        context = this._handleContext(handler, context);
        const index = this.subscribers[event].handlers.indexOf(handler.bind(context));
        this.subscribers[event].handlers.splice(index);
        if (this.subscribers[event].handlers.length === 0)
            delete this.subscribers[event];
    }
    publish(event, value) {
        // always set value even when having no subscribers
        if (!this.hasSubscribers(event))
            this.subscribers[event] = {
                handlers: []
            };
        const oldValue = this.subscribers[event]?.value;
        this.subscribers[event].value = value;
        if (this.verbose || oldValue !== value)
            for (const handler of this.subscribers[event].handlers) {
                handler(value, oldValue);
            }
    }
    once(event) {
        return new Promise((resolve) => {
            const cb = (value) => {
                this.unsubscribe(event, cb);
                resolve(value);
            };
            this.subscribe(event, cb);
        });
    }
}

globalThis.pubsub = globalThis.pubsub || new LittlePubSub();
class PeerInterface {
    options;
    initiator = false;
    channelName;
    channelConfig;
    _connected = false;
    _id;
    config;
    _pc;
    streams = [];
    destroyed = false;
    destroying = false;
    _isNegotiating = false;
    _channelReady = false;
    _firstNegotiation = true;
    _queuedNegotiation = false;
    _connecting = false;
    _pcReady = false;
    _iceComplete = false;
    _iceCompleteTimer = null;
    _closingInterval = null;
    _interval = null;
    _channel;
    _pendingCandidates = [];
    _senderMap = new Map();
    _sendersAwaitingStable = [];
    _batchedNegotiation = false;
    _remoteTracks = [];
    _remoteStreams = [];
    _chunk = null;
    _messagesToSend = [];
    _incomingMessages = {};
    remoteAddress;
    remoteFamily;
    remotePort;
    localAddress;
    localFamily;
    localPort;
    _pubsub = new LittlePubSub(true);
    static get WEBRTC_SUPPORT() {
        return globalThis.RTCPeerConnection ? true : false;
    }
    get channelNegotiated() {
        return this.channelConfig.negotiated;
    }
    constructor(options) {
        options = { ...DEFAULT_OPTIONS, ...options };
        this._id = options.id || crypto.randomUUID();
        this.initiator = options.initiator;
        debug(`new peer ${options}`);
        if (options.channelName)
            this.channelName = options.channelName;
        else if (this.initiator)
            this.channelName = crypto.randomUUID();
        this.options = options;
        this.channelConfig = { ...DEFAULT_CHANNEL_CONFIG, ...options.channelConfig };
        this.config = { ...DEFAULT_CONFIG, ...options.config };
        this.streams = options.streams;
        this.init();
    }
    // HACK: Filter trickle lines when trickle is disabled _354
    _filterTrickle(sdp) {
        return sdp.replace(/a=ice-options:trickle\s\n/g, '');
    }
    async init() {
        if (!PeerInterface.WEBRTC_SUPPORT) {
            const importee = (await import('@koush/wrtc')).default;
            for (const [key, value] of Object.entries(importee)) {
                globalThis[key] = value;
            }
        }
        if (!RTCPeerConnection) {
            throw new Error('WebRTC unsupported');
        }
        try {
            this._pc = new RTCPeerConnection(this.config);
            // We prefer feature detection whenever possible, but sometimes that's not
            // possible for certain implementations.
            // todo: is this needed?
            // @ts-ignore
            this._isReactNativeWebrtc = typeof this._pc._peerConnectionId === 'number';
            this._pc.oniceconnectionstatechange = this._onIceStateChange;
            this._pc.onicegatheringstatechange = this._onIceStateChange;
            this._pc.onconnectionstatechange = this._onConnectionStateChange;
            this._pc.onsignalingstatechange = this._onSignalingStateChange;
            this._pc.onicecandidate = this._onIceCandidate;
            // HACK: Fix for odd Firefox behavior, see: https://github.com/feross/simple-peer/pull/783
            // @ts-ignore
            if (typeof this._pc.peerIdentity === 'object') {
                // @ts-ignore
                this._pc.peerIdentity.catch((err) => {
                    this._destroy(err);
                });
            }
            // Other spec events, unused by this implementation:
            // - onconnectionstatechange
            // - onicecandidateerror
            // - onfingerprintfailure
            // - onnegotiationneeded
            if (this.initiator || this.channelNegotiated) {
                this._setupData({
                    channel: this._pc.createDataChannel(this.channelName, this.channelConfig)
                });
            }
            else {
                this._pc.ondatachannel = this._setupData;
            }
            this.options.streams &&
                this.options.streams.forEach((stream) => {
                    this.addStream(stream);
                });
            this._pc.ontrack = this._onTrack;
            debug('initial negotiation');
            this._needsNegotiation();
        }
        catch (err) {
            this._destroy(err);
        }
    }
    get iceCompleteTimeout() {
        return this.options.iceCompleteTimeout || ICECOMPLETE_TIMEOUT;
    }
    get bufferSize() {
        return (this._channel && this._channel.bufferedAmount) || 0;
    }
    // HACK: it's possible channel.readyState is "closing" before peer.destroy() fires
    // https://bugs.chromium.org/p/chromium/issues/detail?id=882743
    get connected() {
        return this._connected && this._channel.readyState === 'open';
    }
    _destroy(err) {
        if (this.destroyed || this.destroying)
            return;
        this.destroying = true;
        queueMicrotask(() => {
            // allow events concurrent with the call to _destroy() to fire (see _692)
            this.destroyed = true;
            this.destroying = false;
            debug(`destroy: ${err?.message ? err.message : err}`);
            this._connected = false;
            this._pcReady = false;
            this._channelReady = false;
            this._remoteTracks = null;
            this._remoteStreams = null;
            this._senderMap = null;
            clearInterval(this._closingInterval);
            this._closingInterval = null;
            clearInterval(this._interval);
            this._interval = null;
            this._chunk = null;
            if (this._channel) {
                try {
                    this._channel.close();
                }
                catch (err) { }
                // allow events concurrent with destruction to be handled
                this._channel.onmessage = null;
                this._channel.onopen = null;
                this._channel.onclose = null;
                this._channel.onerror = null;
            }
            if (this._pc) {
                try {
                    this._pc.close();
                }
                catch (err) { }
                // allow events concurrent with destruction to be handled
                this._pc.oniceconnectionstatechange = null;
                this._pc.onicegatheringstatechange = null;
                this._pc.onsignalingstatechange = null;
                this._pc.onicecandidate = null;
                this._pc.ontrack = null;
                this._pc.ondatachannel = null;
            }
            this._pc = null;
            this._channel = null;
            if (err)
                this.emit('error', err);
            this.emit('close');
        });
    }
    _addIceCandidate = (candidate) => {
        const iceCandidateObj = new RTCIceCandidate(candidate);
        this._pc.addIceCandidate(iceCandidateObj).catch((err) => {
            if (!iceCandidateObj.address || iceCandidateObj.address.endsWith('.local')) {
                console.warn('Ignoring unsupported ICE candidate.');
            }
            else {
                this._destroy(err);
            }
        });
    };
    _onChannelBufferedAmountLow = () => {
        if (this.destroyed || this._messagesToSend.length === 0)
            return;
        let amount = MAX_BUFFERED_AMOUNT - this._channel.bufferedAmount;
        const { size, id } = this._messagesToSend[0];
        while (amount > 16000) {
            let chunk;
            if (this._messagesToSend[0].message.length <= 16000) {
                chunk = this._messagesToSend[0].message;
                this._messagesToSend.shift();
            }
            else {
                chunk = this._messagesToSend[0].message.slice(0, 16000);
                this._messagesToSend[0].message = this._messagesToSend[0].message.slice(16000, this._messagesToSend[0].message.length);
            }
            this._channel.send(JSON.stringify({ id, chunk, size }));
            amount -= 16000;
        }
        // _messagesToSend
    };
    _onChannelOpen = async () => {
        if (this._connected || this.destroyed)
            return;
        debug('on channel open');
        this._channelReady = true;
        await this._maybeReady();
    };
    _onChannelClose = () => {
        if (this.destroyed)
            return;
        debug('on channel close');
        this._destroy();
    };
    _onTrack = ({ track, streams }) => {
        if (this.destroyed)
            return;
        streams.forEach((eventStream) => {
            debug('on track');
            this.emit('track', { track: track, eventStream });
            this._remoteTracks.push({
                track: track,
                stream: eventStream
            });
            if (this._remoteStreams.some((remoteStream) => {
                return remoteStream.id === eventStream.id;
            }))
                return; // Only fire one 'stream' event, even though there may be multiple tracks per stream
            this._remoteStreams.push(eventStream);
            queueMicrotask(() => {
                debug('on stream');
                this.emit('stream', eventStream); // ensure all tracks have been added
            });
        });
    };
    /**
     * Add a Transceiver to the connection.
     * @param {String} kind
     * @param {Object} init
     */
    addTransceiver(kind, init) {
        if (this.destroying)
            return;
        if (this.destroyed)
            throw new Error('cannot addTransceiver after peer is destroyed');
        debug('addTransceiver()');
        if (this.initiator) {
            try {
                this._pc.addTransceiver(kind, init);
                this._needsNegotiation();
            }
            catch (err) {
                this._destroy(err);
            }
        }
        else {
            this.emit('signal', {
                // request initiator to renegotiate
                type: 'transceiverRequest',
                transceiverRequest: { kind, init }
            });
        }
    }
    /**
     * Add a MediaStream to the connection.
     * @param {MediaStream} stream
     */
    addStream(stream) {
        if (this.destroying)
            return;
        if (this.destroyed)
            throw new Error('cannot addStream after peer is destroyed');
        debug('addStream()');
        stream.getTracks().forEach((track) => {
            this.addTrack(track, stream);
        });
    }
    /**
     * Add a MediaStreamTrack to the connection.
     * @param {MediaStreamTrack} track
     * @param {MediaStream} stream
     */
    addTrack(track, stream) {
        if (this.destroying)
            return;
        if (this.destroyed)
            throw new Error('cannot addTrack after peer is destroyed');
        debug('addTrack()');
        const submap = this._senderMap.get(track) || new Map(); // nested Maps map [track, stream] to sender
        let sender = submap.get(stream);
        if (!sender) {
            sender = this._pc.addTrack(track, stream);
            submap.set(stream, sender);
            this._senderMap.set(track, submap);
            this._needsNegotiation();
        }
        else if (sender.removed) {
            throw new Error('Track has been removed. You should enable/disable tracks that you want to re-add.');
        }
        else {
            throw new Error('Track has already been added to that stream.');
        }
    }
    /**
     * Replace a MediaStreamTrack by another in the connection.
     * @param {MediaStreamTrack} oldTrack
     * @param {MediaStreamTrack} newTrack
     * @param {MediaStream} stream
     */
    replaceTrack(oldTrack, newTrack, stream) {
        if (this.destroying)
            return;
        if (this.destroyed)
            throw new Error('cannot replaceTrack after peer is destroyed');
        debug('replaceTrack()');
        const submap = this._senderMap.get(oldTrack);
        const sender = submap ? submap.get(stream) : null;
        if (!sender) {
            throw new Error('Cannot replace track that was never added.');
        }
        if (newTrack)
            this._senderMap.set(newTrack, submap);
        if (sender.replaceTrack != null) {
            sender.replaceTrack(newTrack);
        }
        else {
            this._destroy(new Error('replaceTrack is not supported in this browser'));
        }
    }
    /**
     * Remove a MediaStreamTrack from the connection.
     * @param {MediaStreamTrack} track
     * @param {MediaStream} stream
     */
    removeTrack(track, stream) {
        if (this.destroying)
            return;
        if (this.destroyed)
            throw new Error('cannot removeTrack after peer is destroyed');
        debug('removeSender()');
        const submap = this._senderMap.get(track);
        const sender = submap ? submap.get(stream) : null;
        if (!sender) {
            throw new Error('Cannot remove track that was never added.');
        }
        try {
            // todo: sender.removed still needed?
            // @ts-ignore
            sender.removed = true;
            this._pc.removeTrack(sender);
        }
        catch (err) {
            if (err.name === 'NS_ERROR_UNEXPECTED') {
                this._sendersAwaitingStable.push(sender); // HACK: Firefox must wait until (signalingState === stable) https://bugzilla.mozilla.org/show_bug.cgi?id=1133874
            }
            else {
                this._destroy(err);
            }
        }
        this._needsNegotiation();
    }
    /**
     * Remove a MediaStream from the connection.
     * @param {MediaStream} stream
     */
    removeStream(stream) {
        if (this.destroying)
            return;
        if (this.destroyed)
            throw new Error('cannot removeStream after peer is destroyed');
        debug('removeSenders()');
        stream.getTracks().forEach((track) => {
            this.removeTrack(track, stream);
        });
    }
    _needsNegotiation() {
        debug('_needsNegotiation');
        if (this._batchedNegotiation)
            return; // batch synchronous renegotiations
        this._batchedNegotiation = true;
        queueMicrotask(() => {
            this._batchedNegotiation = false;
            if (this.initiator || !this._firstNegotiation) {
                debug('starting batched negotiation');
                this.negotiate();
            }
            else {
                debug('non-initiator initial negotiation request discarded');
            }
            this._firstNegotiation = false;
        });
    }
    negotiate() {
        if (this.destroying)
            return;
        if (this.destroyed)
            throw new Error('cannot negotiate after peer is destroyed');
        if (this.initiator) {
            if (this._isNegotiating) {
                this._queuedNegotiation = true;
                debug('already negotiating, queueing');
            }
            else {
                debug('start negotiation');
                setTimeout(() => {
                    // HACK: Chrome crashes if we immediately call createOffer
                    this._createOffer();
                }, 0);
            }
        }
        else {
            if (this._isNegotiating) {
                this._queuedNegotiation = true;
                debug('already negotiating, queueing');
            }
            else {
                debug('requesting negotiation from initiator');
                this.emit('signal', {
                    // request initiator to renegotiate
                    type: 'renegotiate',
                    renegotiate: true
                });
            }
        }
        this._isNegotiating = true;
    }
    _startIceCompleteTimeout() {
        if (this.destroyed)
            return;
        if (this._iceCompleteTimer)
            return;
        debug('started iceComplete timeout');
        this._iceCompleteTimer = setTimeout(() => {
            if (!this._iceComplete) {
                this._iceComplete = true;
                debug('iceComplete timeout completed');
                this.emit('iceTimeout');
                this.emit('_iceComplete');
            }
        }, this.iceCompleteTimeout);
    }
    async _createOffer() {
        if (this.destroyed)
            return;
        try {
            const offer = await this._pc.createOffer(this.options.offerOptions);
            if (this.destroyed)
                return;
            if (!this.options.trickle && !this.options.allowHalfTrickle)
                offer.sdp = this._filterTrickle(offer.sdp);
            offer.sdp = this.options.sdpTransform(offer.sdp);
            const sendOffer = () => {
                if (this.destroyed)
                    return;
                const signal = this._pc.localDescription || offer;
                debug('signal');
                this.emit('signal', {
                    type: signal.type,
                    sdp: signal.sdp
                });
            };
            const onSuccess = () => {
                debug('createOffer success');
                if (this.destroyed)
                    return;
                if (this.options.trickle || this._iceComplete)
                    sendOffer();
                else
                    this.once('_iceComplete', sendOffer); // wait for candidates
            };
            const onError = (err) => {
                this._destroy(err);
            };
            this._pc.setLocalDescription(offer).then(onSuccess).catch(onError);
        }
        catch (error) {
            this._destroy(error);
        }
    }
    _requestMissingTransceivers() {
        if (this._pc.getTransceivers) {
            this._pc.getTransceivers().forEach((transceiver) => {
                // @ts-ignore
                if (!transceiver.mid && transceiver.sender.track && !transceiver.requested) {
                    // @ts-ignore
                    // todo: transceiver.requested still needed?
                    transceiver.requested = true; // HACK: Safari returns negotiated transceivers with a null mid
                    this.addTransceiver(transceiver.sender.track.kind);
                }
            });
        }
    }
    async _createAnswer() {
        if (this.destroyed)
            return;
        try {
            const answer = await this._pc.createAnswer(this.options.answerOptions);
            if (this.destroyed)
                return;
            if (!this.options.trickle && !this.options.allowHalfTrickle)
                answer.sdp = this._filterTrickle(answer.sdp);
            answer.sdp = this.options.sdpTransform(answer.sdp);
            const sendAnswer = () => {
                if (this.destroyed)
                    return;
                const signal = this._pc.localDescription || answer;
                debug('signal');
                this.emit('signal', {
                    type: signal.type,
                    sdp: signal.sdp
                });
                if (!this.initiator)
                    this._requestMissingTransceivers();
            };
            const onSuccess = () => {
                if (this.destroyed)
                    return;
                if (this.options.trickle || this._iceComplete)
                    sendAnswer();
                else
                    this.once('_iceComplete', sendAnswer);
            };
            const onError = (err) => {
                this._destroy(err);
            };
            this._pc.setLocalDescription(answer).then(onSuccess).catch(onError);
        }
        catch (error) {
            this._destroy(error);
        }
    }
    _onConnectionStateChange = () => {
        if (this.destroyed)
            return;
        if (this._pc.connectionState === 'failed') {
            this._destroy(new Error('Connection failed.'));
        }
    };
    _onIceStateChange = async () => {
        if (this.destroyed)
            return;
        const iceConnectionState = this._pc.iceConnectionState;
        const iceGatheringState = this._pc.iceGatheringState;
        debug(`iceStateChange (connection: ${iceConnectionState}) (gathering: ${iceGatheringState})`);
        this.emit('iceStateChange', { iceConnectionState, iceGatheringState });
        if (iceConnectionState === 'connected' || iceConnectionState === 'completed') {
            this._pcReady = true;
            await this._maybeReady();
        }
        if (iceConnectionState === 'failed') {
            this._destroy(new Error('Ice connection failed.'));
        }
        if (iceConnectionState === 'closed') {
            this._destroy(new Error('Ice connection closed.'));
        }
    };
    _maybeReady = () => {
        debug(`maybeReady pc ${this._pcReady} channel ${this._channelReady}`);
        if (this._connected || this._connecting || !this._pcReady || !this._channelReady)
            return;
        this._connecting = true;
        // HACK: We can't rely on order here, for details see https://github.com/js-platform/node-webrtc/issues/339
        const findCandidatePair = async () => {
            if (this.destroyed)
                return;
            try {
                const items = await this.getStats();
                if (this.destroyed)
                    return;
                const remoteCandidates = {};
                const localCandidates = {};
                const candidatePairs = {};
                let foundSelectedCandidatePair = false;
                items.forEach((item) => {
                    // TODO: Once all browsers support the hyphenated stats report types, remove
                    // the non-hypenated ones
                    if (item.type === 'remotecandidate' || item.type === 'remote-candidate') {
                        remoteCandidates[item.id] = item;
                    }
                    if (item.type === 'localcandidate' || item.type === 'local-candidate') {
                        localCandidates[item.id] = item;
                    }
                    if (item.type === 'candidatepair' || item.type === 'candidate-pair') {
                        candidatePairs[item.id] = item;
                    }
                });
                const setSelectedCandidatePair = (selectedCandidatePair) => {
                    foundSelectedCandidatePair = true;
                    let local = localCandidates[selectedCandidatePair.localCandidateId];
                    if (local && (local.ip || local.address)) {
                        // Spec
                        this.localAddress = local.ip || local.address;
                        this.localPort = Number(local.port);
                    }
                    else if (local && local.ipAddress) {
                        // Firefox
                        this.localAddress = local.ipAddress;
                        this.localPort = Number(local.portNumber);
                    }
                    else if (typeof selectedCandidatePair.googLocalAddress === 'string') {
                        // TODO: remove this once Chrome 58 is released
                        local = selectedCandidatePair.googLocalAddress.split(':');
                        this.localAddress = local[0];
                        this.localPort = Number(local[1]);
                    }
                    if (this.localAddress) {
                        this.localFamily = this.localAddress.includes(':') ? 'IPv6' : 'IPv4';
                    }
                    let remote = remoteCandidates[selectedCandidatePair.remoteCandidateId];
                    if (remote && (remote.ip || remote.address)) {
                        // Spec
                        this.remoteAddress = remote.ip || remote.address;
                        this.remotePort = Number(remote.port);
                    }
                    else if (remote && remote.ipAddress) {
                        // Firefox
                        this.remoteAddress = remote.ipAddress;
                        this.remotePort = Number(remote.portNumber);
                    }
                    else if (typeof selectedCandidatePair.googRemoteAddress === 'string') {
                        // TODO: remove this once Chrome 58 is released
                        remote = selectedCandidatePair.googRemoteAddress.split(':');
                        this.remoteAddress = remote[0];
                        this.remotePort = Number(remote[1]);
                    }
                    if (this.remoteAddress) {
                        this.remoteFamily = this.remoteAddress.includes(':') ? 'IPv6' : 'IPv4';
                    }
                    debug(`connect local: ${this.localAddress}:${this.localPort} remote: ${this.remoteAddress}:${this.remotePort}`);
                };
                items.forEach((item) => {
                    // Spec-compliant
                    if (item.type === 'transport' && item.selectedCandidatePairId) {
                        setSelectedCandidatePair(candidatePairs[item.selectedCandidatePairId]);
                    }
                    // Old implementations
                    if ((item.type === 'googCandidatePair' && item.googActiveConnection === 'true') ||
                        ((item.type === 'candidatepair' || item.type === 'candidate-pair') && item.selected)) {
                        setSelectedCandidatePair(item);
                    }
                });
                // Ignore candidate pair selection in browsers like Safari 11 that do not have any local or remote candidates
                // But wait until at least 1 candidate pair is available
                if (!foundSelectedCandidatePair &&
                    (!Object.keys(candidatePairs).length || Object.keys(localCandidates).length)) {
                    setTimeout(findCandidatePair, 100);
                    return;
                }
                else {
                    this._connecting = false;
                    this._connected = true;
                }
                if (this._messagesToSend.length > 0) {
                    try {
                        const { message, id, size } = this._messagesToSend[0];
                        const chunk = message.slice(0, 16000);
                        this._channel.send(JSON.stringify({ id, chunk, size }));
                        this._messagesToSend[0] = { message: message.slice(16000, message.length), id, size };
                    }
                    catch (err) {
                        return this._destroy(err);
                    }
                    this._chunk = null;
                    debug('sent chunk from "write before connect"');
                }
                // If `bufferedAmountLowThreshold` and 'onbufferedamountlow' are unsupported,
                // fallback to using setInterval to implement backpressure.
                if (typeof this._channel.bufferedAmountLowThreshold !== 'number') {
                    this._interval = setInterval(() => this._onInterval(), 150);
                    if (this._interval.unref)
                        this._interval.unref();
                }
                debug('connect');
                this.emit('connect');
            }
            catch (error) {
                throw error;
            }
        };
        return findCandidatePair();
    };
    _onInterval() {
        if (!this._channel || this._channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
            return;
        }
        this._onChannelBufferedAmountLow();
    }
    _onSignalingStateChange = () => {
        if (this.destroyed)
            return;
        if (this._pc.signalingState === 'stable') {
            this._isNegotiating = false;
            // HACK: Firefox doesn't yet support removing tracks when signalingState !== 'stable'
            debug(`flushing sender queue, ${this._sendersAwaitingStable}`);
            this._sendersAwaitingStable.forEach((sender) => {
                this._pc.removeTrack(sender);
                this._queuedNegotiation = true;
            });
            this._sendersAwaitingStable = [];
            if (this._queuedNegotiation) {
                debug('flushing negotiation queue');
                this._queuedNegotiation = false;
                this._needsNegotiation(); // negotiate again
            }
            else {
                debug('negotiated');
                this.emit('negotiated');
            }
        }
        debug(`signalingStateChange ${this._pc.signalingState}`);
        this.emit('signalingStateChange', this._pc.signalingState);
    };
    _onIceCandidate = (event) => {
        if (this.destroyed)
            return;
        if (event.candidate && this.options.trickle) {
            this.emit('signal', {
                type: 'candidate',
                candidate: {
                    candidate: event.candidate.candidate,
                    sdpMLineIndex: event.candidate.sdpMLineIndex,
                    sdpMid: event.candidate.sdpMid
                }
            });
        }
        else if (!event.candidate && !this._iceComplete) {
            this._iceComplete = true;
            this.emit('_iceComplete');
        }
        // as soon as we've received one valid candidate start timeout
        if (event.candidate) {
            this._startIceCompleteTimeout();
        }
    };
    _setupData = (event) => {
        if (!event.channel) {
            // In some situations `pc.createDataChannel()` returns `undefined` (in wrtc),
            // which is invalid behavior. Handle it gracefully.
            // See: https://github.com/feross/simple-peer/issues/163
            return this._destroy(new Error('Data channel event is missing `channel` property'));
        }
        this._channel = event.channel;
        this._channel.binaryType = 'arraybuffer';
        if (typeof this._channel.bufferedAmountLowThreshold === 'number') {
            this._channel.bufferedAmountLowThreshold = MAX_BUFFERED_AMOUNT;
        }
        this.channelName = this._channel.label;
        this._channel.onmessage = this._onChannelMessage;
        this._channel.onbufferedamountlow = this._onChannelBufferedAmountLow;
        this._channel.onopen = this._onChannelOpen;
        this._channel.onclose = this._onChannelClose;
        this._channel.onerror = (event) => {
            const err = event.error instanceof Error
                ? event.error
                : new Error(`Datachannel error: ${event.message} ${event.filename}:${event.lineno}:${event.colno}`);
            this._destroy(err);
        };
        // HACK: Chrome will sometimes get stuck in readyState "closing", let's check for this condition
        // https://bugs.chromium.org/p/chromium/issues/detail?id=882743
        let isClosing = false;
        this._closingInterval = setInterval(() => {
            // No "onclosing" event
            if (this._channel && this._channel.readyState === 'closing') {
                if (isClosing)
                    this._onChannelClose(); // closing timed out: equivalent to onclose firing
                isClosing = true;
            }
            else {
                isClosing = false;
            }
        }, CHANNEL_CLOSING_TIMEOUT);
    };
    async getStats() {
        // statreports can come with a value array instead of properties
        const flattenValues = (report) => {
            if (Object.prototype.toString.call(report.values) === '[object Array]') {
                report.values.forEach((value) => {
                    Object.assign(report, value);
                });
            }
            return report;
        };
        // Promise-based getStats() (standard)
        // @ts-ignore
        if (this._pc.getStats.length === 0 || this._isReactNativeWebrtc) {
            try {
                const res = await this._pc.getStats();
                const reports = [];
                res.forEach((report) => {
                    reports.push(flattenValues(report));
                });
                return reports;
            }
            catch (error) {
                console.error(error);
            }
        }
    }
    _onChannelMessage = (event) => {
        if (this.destroyed)
            return;
        let data = event.data;
        // if (data instanceof ArrayBuffer) data = Buffer.from(data)
        const { chunk, id, size } = JSON.parse(data);
        if (!this._incomingMessages[id]) {
            this._incomingMessages[id] = [];
        }
        // send creates a wrapper around the data to send
        // for the moment this is an object containing
        // { chunk, id, size }
        // that wrapper gets strinified (for now)
        // for now we just contvert the chunk back to a uint8array
        // in the future would want to use varint
        // reconstruct into an array and append the previeus result
        this._incomingMessages[id] = [...this._incomingMessages[id], ...Object.values(chunk)];
        if (this._incomingMessages[id].length === size) {
            // convert the array to a Uint8Array again
            this.emit('data', new Uint8Array(this._incomingMessages[id]));
            delete this._incomingMessages[id];
        }
    };
    emit(event, value) {
        this._pubsub.publish(event, value);
    }
    on(event, cb) {
        this._pubsub.subscribe(event, cb);
    }
    once(event, cb) {
        const once = (data) => {
            cb(data);
            this._pubsub.unsubscribe(event, once);
        };
        this._pubsub.subscribe(event, once);
    }
}

/*! simple-peer. MIT License. Feross Aboukhadijeh <https://feross.org/opensource> */
/**
 * WebRTC peer connection. Same API as node core `net.Socket`, plus a few extra methods.
 * Duplex stream.
 * @param {Object} options
 */
class Peer extends PeerInterface {
    get id() {
        return this._id;
    }
    address() {
        return {
            port: this.localPort,
            family: this.localFamily,
            address: this.localAddress
        };
    }
    signal(data) {
        if (this.destroying)
            return;
        if (this.destroyed)
            throw new Error('cannot signal after peer is destroyed');
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            }
            catch (err) {
                data = {};
            }
        }
        debug('signal()');
        if (data.renegotiate && this.initiator) {
            debug('got request to renegotiate');
            this._needsNegotiation();
        }
        if (data.transceiverRequest && this.initiator) {
            debug('got request for transceiver');
            this.addTransceiver(data.transceiverRequest.kind, data.transceiverRequest.init);
        }
        if (data.candidate) {
            if (this._pc.remoteDescription && this._pc.remoteDescription.type) {
                this._addIceCandidate(data.candidate);
            }
            else {
                this._pendingCandidates.push(data.candidate);
            }
        }
        if (data.sdp) {
            this._pc
                .setRemoteDescription(new RTCSessionDescription(data))
                .then(() => {
                if (this.destroyed)
                    return;
                this._pendingCandidates.forEach((candidate) => {
                    this._addIceCandidate(candidate);
                });
                this._pendingCandidates = [];
                if (this._pc.remoteDescription.type === 'offer')
                    this._createAnswer();
            })
                .catch((err) => {
                this._destroy(err);
            });
        }
        if (!data.sdp && !data.candidate && !data.renegotiate && !data.transceiverRequest) {
            this._destroy(new Error('signal() called with invalid signal data'));
        }
    }
    /**
     * Send text/binary data to the remote peer.
     * @param {ArrayBufferView|ArrayBuffer|Buffer|string|Blob} chunk
     */
    send(message, id = crypto.randomUUID()) {
        if (this.destroying)
            return;
        if (this.destroyed)
            throw new Error('cannot send after peer is destroyed');
        if (!this.connected)
            return this._messagesToSend.push({ message, id, size: message.length });
        if (this._channel.bufferedAmount < MAX_BUFFERED_AMOUNT - 16000) {
            debug('sending');
            const chunk = message.slice(0, 16000);
            this._channel.send(JSON.stringify({ id, chunk, size: message.length }));
            this._messagesToSend.push({ message: message.slice(16000, message.length), id, size: message.length });
        }
        else {
            this._messagesToSend.push({ message, id, size: message.length });
        }
    }
}

export { Peer as default };
