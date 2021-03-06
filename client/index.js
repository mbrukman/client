let { createNanoEvents } = require('nanoevents')
let { isFirstOlder } = require('@logux/core/is-first-older')
let { WsConnection } = require('@logux/core/ws-connection')
let { MemoryStore } = require('@logux/core/memory-store')
let { ClientNode } = require('@logux/core/client-node')
let { Reconnect } = require('@logux/core/reconnect')
let { Log } = require('@logux/core/log')
let nanoid = require('nanoid')

function tabPing (c) {
  localStorage.setItem(c.options.prefix + ':tab:' + c.tabId, Date.now())
}

function cleanTabActions (client, id) {
  client.log.removeReason('tab' + id).then(() => {
    if (client.isLocalStorage) {
      localStorage.removeItem(client.options.prefix + ':tab:' + id)
    }
  })
}

let ALLOWED_META = ['id', 'time', 'channels']

class Client {
  constructor (opts = { }) {
    this.options = opts

    if (process.env.NODE_ENV !== 'production') {
      if (typeof this.options.server === 'undefined') {
        throw new Error('Missed server option in Logux client')
      }
      if (typeof this.options.subprotocol === 'undefined') {
        throw new Error('Missed subprotocol option in Logux client')
      }
      if (typeof this.options.userId === 'undefined') {
        throw new Error('Missed userId option in Logux client. ' +
                        'Pass false if you have no users.')
      }
    }

    if (typeof this.options.prefix === 'undefined') {
      this.options.prefix = 'logux'
    }

    this.isLocalStorage = false
    if (typeof localStorage !== 'undefined') {
      let random = nanoid()
      try {
        localStorage.setItem(random, '1')
        localStorage.removeItem(random)
        this.isLocalStorage = true
      } catch (e) {}
    }

    if (this.options.userId) {
      this.options.userId = this.options.userId.toString()
    } else {
      this.options.userId = 'false'
    }

    if (!this.options.time) {
      this.clientId = this.options.userId + ':' + this.getClientId()
      this.tabId = nanoid(8)
    } else {
      this.tabId = this.options.time.lastId + 1 + ''
      this.clientId = this.options.userId + ':' + this.tabId
    }

    this.nodeId = this.clientId + ':' + this.tabId

    let auth
    if (/^ws:\/\//.test(this.options.server) && !opts.allowDangerousProtocol) {
      auth = async cred => {
        if (typeof cred !== 'object' || cred.env !== 'development') {
          console.error(
            'Without SSL, old proxies block WebSockets. ' +
            'Use WSS for Logux or set allowDangerousProtocol option.'
          )
          return false
        } else {
          return true
        }
      }
    }

    let store = this.options.store || new MemoryStore()

    let log
    if (this.options.time) {
      log = this.options.time.nextLog({ store, nodeId: this.nodeId })
    } else {
      log = new Log({ store, nodeId: this.nodeId })
    }
    this.log = log

    log.on('preadd', (action, meta) => {
      let isOwn = meta.id.includes(` ${ this.nodeId } `)
      if (isOwn && !meta.subprotocol) {
        meta.subprotocol = this.options.subprotocol
      }
      if (meta.sync && !meta.resubscribe) meta.reasons.push('syncing')
    })

    this.last = { }
    this.subscriptions = { }
    let subscribing = { }
    let unsubscribing = { }

    this.emitter = createNanoEvents()
    this.on('add', (action, meta) => {
      let type = action.type
      let json, last
      if (type === 'logux/processed' || type === 'logux/undo') {
        this.log.removeReason('syncing', { id: action.id })
      }
      if (type === 'logux/subscribe' && !meta.resubscribe) {
        subscribing[meta.id] = action
      } else if (type === 'logux/unsubscribe') {
        unsubscribing[meta.id] = action
      } else if (type === 'logux/processed' && unsubscribing[action.id]) {
        let unsubscription = unsubscribing[action.id]
        json = JSON.stringify({ ...unsubscription, type: 'logux/subscribe' })
        let subscribers = this.subscriptions[json]
        if (subscribers) {
          if (subscribers === 1) {
            delete this.subscriptions[json]
          } else {
            this.subscriptions[json] = subscribers - 1
          }
        }
      } else if (type === 'logux/processed' && subscribing[action.id]) {
        let subscription = subscribing[action.id]
        delete subscribing[action.id]
        json = JSON.stringify(subscription)
        if (this.subscriptions[json]) {
          this.subscriptions[json] += 1
        } else {
          this.subscriptions[json] = 1
        }
        last = this.last[subscription.channel]
        if (!last || isFirstOlder(last, meta)) {
          this.last[subscription.channel] = { id: meta.id, time: meta.time }
        }
      } else if (type === 'logux/undo') {
        delete subscribing[action.id]
        delete unsubscribing[action.id]
      } else if (meta.channels) {
        if (!meta.id.includes(' ' + this.clientId + ':')) {
          meta.channels.forEach(channel => {
            last = this.last[channel]
            if (!last || isFirstOlder(last, meta)) {
              this.last[channel] = { id: meta.id, time: meta.time }
            }
          })
        }
      }
      if (process.env.NODE_ENV !== 'production') {
        if (type === 'logux/subscribe' || type === 'logux/unsubscribe') {
          if (!meta.sync) {
            console.error(type + ' action without meta.sync')
          }
        }
      }
    })

    this.tabPing = 60000
    this.tabTimeout = 10 * this.tabPing
    let reason = 'tab' + this.tabId
    if (this.isLocalStorage) {
      let unbind = log.on('add', (action, meta) => {
        if (meta.reasons.includes(reason)) {
          tabPing(this)
          this.pinging = setInterval(() => {
            tabPing(this)
          }, this.tabPing)
          unbind()
        }
      })
    }

    let connection
    if (typeof this.options.server === 'string') {
      let ws = new WsConnection(this.options.server)
      connection = new Reconnect(ws, {
        minDelay: this.options.minDelay,
        maxDelay: this.options.maxDelay,
        attempts: this.options.attempts
      })
    } else {
      connection = this.options.server
    }

    let outFilter = async (action, meta) => {
      let user = meta.id.split(' ')[1].replace(/:.*$/, '')
      return !!meta.sync && user === this.options.userId
    }

    let outMap = async (action, meta) => {
      let filtered = { }
      for (let i in meta) {
        if (ALLOWED_META.includes(i)) {
          filtered[i] = meta[i]
        }
        if (meta.subprotocol && meta.subprotocol !== this.options.subprotocol) {
          filtered.subprotocol = meta.subprotocol
        }
      }
      return [action, filtered]
    }

    this.node = new ClientNode(this.nodeId, this.log, connection, {
      credentials: this.options.credentials,
      subprotocol: this.options.subprotocol,
      outFilter,
      timeout: this.options.timeout,
      outMap,
      ping: this.options.ping,
      auth
    })

    this.node.on('debug', (type, stack) => {
      if (type === 'error') {
        console.error('Error on Logux server:\n', stack)
      }
    })

    let disconnected = true
    this.node.on('state', () => {
      let state = this.node.state
      if (state === 'synchronized' || state === 'sending') {
        if (disconnected) {
          disconnected = false
          for (let i in this.subscriptions) {
            let action = JSON.parse(i)
            let since = this.last[action.channel]
            if (since) action.since = since
            this.log.add(action, { sync: true, resubscribe: true })
          }
        }
      } else if (this.node.state === 'disconnected') {
        disconnected = true
      }
    })

    this.onUnload = this.onUnload.bind(this)
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('unload', this.onUnload)
    }
  }

  start () {
    this.cleanPrevActions()
    this.node.connection.connect()
  }

  on (event, listener) {
    return this.log.emitter.on(event, listener)
  }

  destroy () {
    this.onUnload()
    this.node.destroy()
    clearInterval(this.pinging)
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('unload', this.onUnload)
    }
  }

  clean () {
    this.destroy()
    return this.log.store.clean ? this.log.store.clean() : Promise.resolve()
  }

  cleanPrevActions () {
    if (!this.isLocalStorage) return

    for (let i in localStorage) {
      let prefix = this.options.prefix + ':tab:'
      if (i.slice(0, prefix.length) === prefix) {
        let time = parseInt(localStorage.getItem(i))
        if (Date.now() - time > this.tabTimeout) {
          cleanTabActions(this, i.slice(prefix.length))
        }
      }
    }
  }

  onUnload () {
    if (this.pinging) cleanTabActions(this, this.tabId)
  }

  getClientId () {
    return nanoid(8)
  }
}

module.exports = { Client }
