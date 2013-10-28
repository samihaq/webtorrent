// TODO:
// - Use the same DHT object for looking up multiple torrents
// - Persist the routing table for later bootstrapping
// - Should work in Node, not just browser

module.exports = DHT

var bencode = require('bncode')
var bops = require('bops')
var compact2string = require('compact2string')
var EventEmitter = require('events').EventEmitter
var socket = require('../../socket')
var is = require('core-util-is') // added in Node 0.12
var util = require('util')

var MAX_NODES = 5000
var BOOTSTRAP_NODES = [
  'dht.transmissionbt.com:6881',
  'router.bittorrent.com:6881',
  'router.utorrent.com:6881'
]

function randomId () {
  var array = new Uint8Array(20)
  window.crypto.getRandomValues(array)
  return array
}

function parseNodeInfo (compact) {
  console.log(parseNodeInfo)
  try {
    var nodes = []
    for (var i = 0; i < compact.length; i += 26) {
      nodes.push(compact2string(bops.subarray(compact, i+20, i+26)))
    }
    return nodes
  } catch (err) {
    console.warn('Invalid node info ' + compact)
    return []
  }
}

function parsePeerInfo (list) {
  try {
    return list.map(compact2string)
  } catch (err) {
    console.warn('Invalid peer info ' + list)
    return []
  }
}

util.inherits(DHT, EventEmitter)

/**
 * Create a new DHT
 * @param {string|Buffer} infoHash
 */
function DHT (infoHash) {
  log('new DHT')
  var self = this
  EventEmitter.call(self)

  // Support infoHash as string or Buffer
  if (is.isString(infoHash)) {
    infoHash = bops.from(infoHash, 'hex')
  } else if (!is.isBuffer(infoHash)) {
    throw new Error('DHT() requires string or buffer infoHash')
  }

  self.infoHash = infoHash
  self.nodes = {}
  self.peers = {}
  self.queue = [].concat(BOOTSTRAP_NODES)

  // Number of nodes we still need to find to satisfy the last call to findPeers
  self.missingNodes = 0

  self.nodeId = randomId()
  console.log('our node id: ' + bops.to(self.nodeId, 'hex'))
  console.log(self.nodeId)

  self.requestId = 1
  self.pendingRequests = {}

  self.message = {
    t: self.requestId.toString(),
    y: 'q',
    q: 'get_peers',
    a: {
      id: self.nodeId,
      info_hash: self.infoHash
    }
  }
  console.log(self.message)
  self.message = bencode.encode(self.message)

  self.pendingRequests[self.requestId] = 1

  self.socket = new socket.UDPSocket()
  self.socket.on('data', self._onData.bind(self))
}

DHT.prototype._onNode = function (addr) {
  var self = this
  if (self.nodes[addr]) return // already know about this node
  process.nextTick(function () {
    self.emit('node', self.infoHash, addr)
  })
  if (self.missingNodes > 0) return self.query(addr)
  if (self.queue.length < 50) self.queue.push(addr)
}

DHT.prototype._onPeer = function (addr) {
  var self = this
  if (self.peers[addr]) return
  self.peers[addr] = true
  self.missingNodes = Math.max(0, self.missingNodes - 1)
  process.nextTick(function () {
    self.emit('peer', self.infoHash, addr)
  })
}

DHT.prototype._onData = function (data, host, port) {
  var self = this
  self.nodes[host + ':' + port] = true

  var message
  try {
    console.log('got response from ' + host + ':' + port)
    message = bencode.decode(data)
    console.log(message)
    if (!message) throw new Error('message is undefined')
  } catch (err) {
    console.error('Failed to decode UDP data from node ' + host + ':' + port)
    console.error(err)
    return
  }

  if (!message.t || (bops.to(message.t) !== self.requestId.toString())) {
    log(message.t)
    log(self.requestId)
    log('wrong message requestId')
    return
  }

  var r = message && message.r

  if (r && bops.is(r.nodes)) {
    log('nodes')
    parseNodeInfo(r.nodes).forEach(self._onNode.bind(self))
  }
  if (r && bops.is(r.values)) {
    log('peers')
    parsePeerInfo(r.values).forEach(self._onPeer.bind(self))
  }
}

DHT.prototype.query = function (addr) {
  var self = this
  if (Object.keys(self.nodes).length > MAX_NODES) return

  var host = addr.split(':')[0]
  var port = Number(addr.split(':')[1])
  self.socket.sendTo(self.message, host, port)
}

DHT.prototype.findPeers = function (num, timeout) {
  var self = this
  if (!num) num = 1
  if (!timeout) timeout = 0

  // TODO: keep track of missing nodes for each `findPeers` call separately!
  self.missingNodes += num

  while (self.queue.length) {
    self.query(self.queue.pop())
  }

  if (timeout) setTimeout(self.stop.bind(self), timeout)
}

DHT.prototype.stop = function () {
  var self = this
  delete self.pendingRequests[self.requestId]
}

DHT.prototype.__defineGetter__('peersFound', function() {
  var self = this
  return Object.keys(self.peers).length
})

DHT.prototype.__defineGetter__('nodesFound', function () {
  var self = this
  return Object.keys(self.nodes).length
})

DHT.prototype.__defineGetter__('queued', function () { //TODO
  return 0
})
