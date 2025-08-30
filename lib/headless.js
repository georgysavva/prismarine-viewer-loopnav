/* global THREE */
// 修改为串行实现。现在并行实现在结束的时候会有问题
// 而且开始时视角平滑，发送一段时间后，就变成一大块一大块的，有卡顿
// 串行用队列实现，但可能会遇到的问题是生物的渲染不一定实时。因为此时渲染+发送和 bot.world 会异步。 除非把 bot.world 的采样频率降低
// 之后再考虑解决
function safeRequire (path) {
  try {
    return require(path)
  } catch (e) {
    return {}
  }
}
const { spawn } = require('child_process')
const net = require('net')
global.THREE = require('three')
global.Worker = require('worker_threads').Worker
const { createCanvas } = safeRequire('node-canvas-webgl/lib')

const { WorldView, Viewer, getBufferFromStream } = require('../viewer')

module.exports = (bot, { viewDistance = 6, output = 'output.mp4', frames = -1, width = 512, height = 512, logFFMPEG = false, jpegOptions }) => {
  const canvas = createCanvas(width, height)
  const renderer = new THREE.WebGLRenderer({ canvas })
  const viewer = new Viewer(renderer)

  let client = new net.Socket()
  let idx = 0
  let queue = []
  let ended = false
  let running = false
  let sentendsignal = false
  let lastSendTime = 0
  const MIN_SEND_INTERVAL = 3 // Minimum interval between sends in milliseconds

  function connectClient() {
    client = new net.Socket()
    client.on('error', (err) => {
      console.error('[headless] Socket error:', err)
    })

    client.on('close', () => {
      console.log('[headless] Socket closed')
    })
    client.on('end', () => {
      console.log('[headless] Socket ended');
      console.log('[headless] Socket state at end:', {
          writable: client.writable,
          destroyed: client.destroyed,
          connecting: client.connecting,
          bytesWritten: client.bytesWritten,
          bytesRead: client.bytesRead
      });
    });  
    client.connect(parseInt(port, 10), host, () => {
      console.log('[headless] Connected to server')
      update(null)
    })
  }

  if (!viewer.setVersion(bot.version)) {
    return false
  }
  viewer.setFirstPersonCamera(bot.entity.position, bot.entity.yaw, bot.entity.pitch)

  // Load world
  const worldView = new WorldView(bot.world, viewDistance, bot.entity.position)
  viewer.listen(worldView)
  function enqueue (pos) {
    if (ended) {
      return
    } 
    queue.push(pos)
    // console.log('[headless] enqueue', queue.length)
    processQueue()
  }
  function sendEndSignal() {
    console.log('[headless] sending zero end of stream')
    sentendsignal = true
    zero = new Uint8Array(4)
    zeroview = new DataView(zero.buffer, 0)
    zeroview.setUint32(0, 0, true)
    client.write(zero)
    client.end()
  }
  async function processQueue() {
    if (running || sentendsignal) return
    running = true;
    // console.log('[headless] processQueue', queue.length)
    while (queue.length > 0) {
      const pos = queue.shift();
      const now = Date.now()
      if (now - lastSendTime < MIN_SEND_INTERVAL) {
        // If we're sending too fast, wait a bit
        await new Promise(resolve => setTimeout(resolve, MIN_SEND_INTERVAL - (now - lastSendTime)))
      }
      await updbotPosition(pos);
      lastSendTime = Date.now()
    }
  
    if (ended) {
      sendEndSignal();
    }
    running = false;
  }
  async function updbotPosition (pos) {
    viewer.setFirstPersonCamera(pos, pos.yaw, pos.pitch)
    worldView.updatePosition(pos)
    await update(pos)
  }
  function writeAsync(socket, data, encoding) {
    return new Promise((resolve, reject) => {
      const canWrite = socket.write(data, (err) => err ? reject(err) : resolve());
      // 如果不能立即写入，等待 drain 事件
      if (!canWrite) {
        socket.once('drain', resolve);
      }
    });
  }
  async function update(pos) {
    try {
      if (pos !== null) {
        pos.renderPTimeOnEvent = performance.now();
      }
      viewer.update()
      renderer.render(viewer.scene, viewer.camera)
      if (pos !== null) {
        pos.renderPTimeAfterRender = performance.now();
      }
      if (pos === null) {
          return
      }
      
      const imageStream = canvas.createJPEGStream({
          bufsize: 32768,
          quality: 1,
          progressive: false,
          ...jpegOptions
      })
      
      buffer = await getBufferFromStream(imageStream)
      pos.renderTick = bot.time.age;
      pos.renderPTime = performance.now(); 
      const sizebuff = new Uint8Array(4)
      const view = new DataView(sizebuff.buffer, 0)
      view.setUint32(0, buffer.length, true)
      
      const posData = JSON.stringify(pos)
      const posSizeBuff = new Uint8Array(4)
      const posView = new DataView(posSizeBuff.buffer, 0)
      posView.setUint32(0, posData.length, true)
      await new Promise(resolve => setTimeout(resolve, 100));
      await writeAsync(client, posSizeBuff);
      await writeAsync(client, posData);
      await writeAsync(client, sizebuff);
      await writeAsync(client, buffer);
      
    } catch (err) {
      console.error('[headless] Error in update:', err);
      console.error('[headless] Error details:', {
          code: err.code,
          message: err.message,
          stack: err.stack
      });
      // 添加更多错误上下文
      console.error('[headless] Socket state at error:', {
          writable: client.writable,
          destroyed: client.destroyed,
          connecting: client.connecting,
          bytesWritten: client.bytesWritten,
          bytesRead: client.bytesRead
      });
  }
  }
  worldView.init(bot.entity.position)
  const [host, port] = output.split(':')
  connectClient()
  // Force end of stream
  bot.on('endtask', () => { 
    ended = true
    console.log("[headless] receive end")
  })
  bot.on('physicsTick', () => {
    if (sentendsignal === false && running === false) {
      processQueue()
    }
  })
  bot.on('abnormal_exit', () => {
    console.log("[headless] abnormal exit")
    sendEndSignal()
    process.exit(1)
  })
  // Register events
  bot.on('sentPosAction', enqueue)
  worldView.listenToBot(bot)

  bot._client.on('error', (err) => {
    console.error('[bot._client error]', err.code, err.message);
  });
  return client
}