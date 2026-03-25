import { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } from "electron"
import WebTorrent from "webtorrent"
import fs from "fs"
import path from "path"
import https from "https"
import dns from "dns"
import http from "http"
import net from "net"
import os from "os"
import NatAPI from "@silentbot1/nat-api"
import crypto from "crypto"

let client = null

let win

let internetState = true
let failCount = 0
let checkInFlight = false
let shuttingDown = false
let updateTimer = null
let lastStats = {
  torrents: [],
  isOnline: true,
  totalDownload: 0,
  totalUpload: 0
}
let clientError = null
let exitRequested = false
let portFallbackActive = false

let webServer = null
let webServerState = {
  running: false,
  host: null,
  port: null,
  error: null
}
let tray = null
let natClient = null
let portForwardingInFlight = false
let portForwardingState = {
  torrent: {
    enabled: false,
    active: false,
    error: null,
    port: null,
    note: null
  },
  webUi: {
    enabled: false,
    active: false,
    error: null,
    port: null,
    note: null
  },
  externalIp: null
}

const FAIL_LIMIT = 5
const CHECK_TIMEOUT_MS = 2500
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

const PROBE_DNS = [
  "cloudflare.com",
  "google.com",
  "microsoft.com"
]

const PROBE_URLS = [
  "https://clients3.google.com/generate_204",
  "https://www.cloudflare.com/cdn-cgi/trace",
  "https://www.msftconnecttest.com/connecttest.txt"
]

const TCP_PROBES = [
  { host: "1.1.1.1", port: 443 },
  { host: "1.0.0.1", port: 443 }
]

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 4
})

function randomId(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = crypto.randomBytes(length)
  let out = ""
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length]
  }
  return out
}

function getClientVersionToken() {
  const version = app.getVersion ? app.getVersion() : "0.0.0"
  const parts = String(version).split(".").map(part => parseInt(part, 10))
  const major = Number.isFinite(parts[0]) ? parts[0] : 0
  const minor = Number.isFinite(parts[1]) ? parts[1] : 0
  const patch = Number.isFinite(parts[2]) ? parts[2] : 0
  const patchToken = String(patch).padStart(2, "0").slice(-2)
  return `${major % 10}${minor % 10}${patchToken}`
}

function buildPeerId() {
  const versionToken = getClientVersionToken()
  const prefix = `-ZT${versionToken}-`
  const suffix = randomId(12)
  const peerId = Buffer.from(prefix + suffix, "ascii")
  if (peerId.length === 20) return peerId
  const fallback = Buffer.from("-ZT0000-" + randomId(12), "ascii")
  return fallback.slice(0, 20)
}

let downloadFolder = null
let torrentFolder = null
let saveFile = null
let settingsFile = null
let storageReady = false
let updateCheckTimer = null
let updateState = {
  available: false,
  latestVersion: null,
  url: "https://github.com/Zayncoder1/Zayn-Torrent-Monitor/releases"
}

const defaultSettings = {
  torrentPort: 0,
  portForwarding: {
    torrent: true,
    webUi: false
  },
  behavior: {
    autoSeed: false,
    backgroundOnClose: true
  },
  webUi: {
    enabled: false,
    host: "0.0.0.0",
    port: 80
  }
}

let settings = null

function ensureDir(dirPath) {
  if (!dirPath) return
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function moveLegacyPath(src, dest) {
  if (!src || !dest) return
  if (!fs.existsSync(src)) return
  if (fs.existsSync(dest)) return
  try {
    fs.renameSync(src, dest)
  } catch {
    try {
      const stat = fs.statSync(src)
      if (stat.isDirectory()) {
        fs.cpSync(src, dest, { recursive: true, force: true })
        fs.rmSync(src, { recursive: true, force: true })
      } else {
        fs.copyFileSync(src, dest)
        fs.rmSync(src, { force: true })
      }
    } catch {
      // ignore
    }
  }
}

function migrateLegacyStorage(dataRoot) {
  const roots = [
    process.cwd(),
    path.dirname(process.execPath || "")
  ]

  const seen = new Set()

  roots.forEach(root => {
    if (!root) return
    if (seen.has(root)) return
    seen.add(root)
    if (dataRoot && path.resolve(root) === path.resolve(dataRoot)) return

    moveLegacyPath(path.join(root, "downloads"), downloadFolder)
    moveLegacyPath(path.join(root, "torrents"), torrentFolder)
    moveLegacyPath(path.join(root, "saved-torrents.json"), saveFile)
    moveLegacyPath(path.join(root, "settings.json"), settingsFile)
  })
}

function initStoragePaths() {
  if (storageReady) return
  const dataRoot = app.getPath("userData")

  downloadFolder = path.join(dataRoot, "downloads")
  torrentFolder = path.join(dataRoot, "torrents")
  saveFile = path.join(dataRoot, "saved-torrents.json")
  settingsFile = path.join(dataRoot, "settings.json")

  ensureDir(dataRoot)
  migrateLegacyStorage(dataRoot)

  ensureDir(downloadFolder)
  ensureDir(torrentFolder)
  if (!fs.existsSync(saveFile)) fs.writeFileSync(saveFile, "[]")

  storageReady = true
}

function createWindow() {

  initStoragePaths()
  if (!settings) settings = loadSettings()

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  win.loadFile("index.html")
  win.webContents.on("did-finish-load", () => {
    sendUpdateStatus()
  })

  if (!client) {
    createClient()
    loadSavedTorrents()
  }

  startWebUi()
  updateTrayState()
  startUpdateChecks()

  updateTimer = setInterval(updateLoop, 1000)

  win.on("close", (event) => {
    if (exitRequested) return
    if (settings?.behavior?.backgroundOnClose) {
      event.preventDefault()
      win.hide()
      updateTrayState()
    }
  })

  win.on("closed", () => {
    win = null
  })

}

app.whenReady().then(createWindow)

app.on("window-all-closed", () => {
  if (settings?.behavior?.backgroundOnClose) return
  shutdownAndExit(0)
})

app.on("before-quit", () => {
  if (exitRequested) return
  shutdownServices()
})

process.on("SIGINT", () => {
  shutdownAndExit(0)
})

async function updateLoop() {

  if (shuttingDown) return

  const online = await checkInternet()

  if (online) {

    failCount = 0
    internetState = true

  } else {

    failCount++

    if (failCount >= FAIL_LIMIT) {
      internetState = false
    }

  }

  sendStats()

}

async function shutdownServices() {
  if (shuttingDown) return
  shuttingDown = true

  if (updateTimer) {
    clearInterval(updateTimer)
    updateTimer = null
  }

  try {
    stopWebUi()
  } catch {
    // ignore
  }

  try {
    await destroyPortForwarding()
  } catch {
    // ignore
  }

  try {
    await destroyClientAsync()
  } catch {
    // ignore
  }

  if (updateCheckTimer) {
    clearInterval(updateCheckTimer)
    updateCheckTimer = null
  }
}

async function shutdownAndExit(code) {
  if (exitRequested) return
  exitRequested = true
  await shutdownServices()
  app.exit(code)
}

function normalizePort(value, fallback) {
  const num = Number(value)
  if (Number.isFinite(num) && num >= 0 && num <= 65535) {
    return Math.floor(num)
  }
  return fallback
}

function normalizeSettings(raw) {
  const pfRaw = raw?.portForwarding ?? {}
  const torrentForwarding = pfRaw.torrent !== undefined
    ? Boolean(pfRaw.torrent)
    : (pfRaw.enabled !== undefined ? Boolean(pfRaw.enabled) : defaultSettings.portForwarding.torrent)
  const webUiForwarding = pfRaw.webUi !== undefined
    ? Boolean(pfRaw.webUi)
    : defaultSettings.portForwarding.webUi
  const autoSeed = raw?.behavior?.autoSeed === undefined
    ? defaultSettings.behavior.autoSeed
    : Boolean(raw.behavior.autoSeed)
  const backgroundOnClose = raw?.behavior?.backgroundOnClose === undefined
    ? defaultSettings.behavior.backgroundOnClose
    : Boolean(raw.behavior.backgroundOnClose)

  return {
    torrentPort: normalizePort(raw?.torrentPort, defaultSettings.torrentPort),
    portForwarding: {
      torrent: torrentForwarding,
      webUi: webUiForwarding
    },
    behavior: {
      autoSeed,
      backgroundOnClose
    },
    webUi: {
      enabled: raw?.webUi?.enabled === undefined
        ? defaultSettings.webUi.enabled
        : Boolean(raw.webUi.enabled),
      host: typeof raw?.webUi?.host === "string" && raw.webUi.host.trim().length > 0
        ? raw.webUi.host.trim()
        : defaultSettings.webUi.host,
      port: normalizePort(raw?.webUi?.port, defaultSettings.webUi.port)
    }
  }
}

function loadSettings() {
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify(defaultSettings, null, 2))
    return normalizeSettings(defaultSettings)
  }

  try {
    const data = fs.readFileSync(settingsFile, "utf8")
    if (data.trim().length === 0) {
      fs.writeFileSync(settingsFile, JSON.stringify(defaultSettings, null, 2))
      return normalizeSettings(defaultSettings)
    }
    return normalizeSettings(JSON.parse(data))
  } catch {
    fs.writeFileSync(settingsFile, JSON.stringify(defaultSettings, null, 2))
    return normalizeSettings(defaultSettings)
  }
}

function saveSettings(next) {
  fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2))
}

function normalizeEntry(entry) {
  if (!entry) return null
  if (typeof entry === "string") {
    const value = entry.trim()
    if (!value) return null
    if (value.startsWith("magnet:")) return { type: "magnet", value }
    return { type: "file", value }
  }
  if (typeof entry === "object") {
    const type = entry.type === "magnet" ? "magnet" : "file"
    const value = typeof entry.value === "string" ? entry.value.trim() : ""
    if (!value) return null
    const infoHash = typeof entry.infoHash === "string" ? entry.infoHash.trim() : ""
    return infoHash ? { type, value, infoHash } : { type, value }
  }
  return null
}

function entryKey(entry) {
  return `${entry.type}:${entry.value}`
}

function infoHashFromMagnet(magnet) {
  if (typeof magnet !== "string") return null
  const match = magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/)
  if (!match) return null
  const hash = match[1]
  if (hash.length === 40) return hash.toLowerCase()
  if (hash.length === 32) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    let bits = ""
    const upper = hash.toUpperCase()
    for (const char of upper) {
      const val = alphabet.indexOf(char)
      if (val === -1) return null
      bits += val.toString(2).padStart(5, "0")
    }
    let hex = ""
    for (let i = 0; i + 4 <= bits.length; i += 4) {
      const chunk = bits.slice(i, i + 4)
      hex += parseInt(chunk, 2).toString(16)
    }
    return hex.toLowerCase()
  }
  return null
}

function readSavedEntries() {
  let saved = []

  try {
    const data = fs.readFileSync(saveFile, "utf8")
    if (data.trim().length > 0) saved = JSON.parse(data)
  } catch {
    saved = []
  }

  if (!Array.isArray(saved)) saved = []

  const merged = new Map()
  saved.forEach(item => {
    const normalized = normalizeEntry(item)
    if (!normalized) return
    merged.set(entryKey(normalized), normalized)
  })

  return Array.from(merged.values())
}

function saveSavedEntries(entries) {
  fs.writeFileSync(saveFile, JSON.stringify(entries, null, 2))
}

function addSavedEntry(entry) {
  const normalized = normalizeEntry(entry)
  if (!normalized) return false

  const entries = readSavedEntries()
  const key = entryKey(normalized)
  if (entries.some(e => entryKey(e) === key)) return false

  entries.push(normalized)
  saveSavedEntries(entries)
  return true
}

function updateSavedEntryInfoHash(entry, infoHash) {
  const normalized = normalizeEntry(entry)
  if (!normalized || !infoHash) return
  const hash = String(infoHash).toLowerCase()
  const entries = readSavedEntries()
  let changed = false

  const updated = entries.map(item => {
    if (entryKey(item) !== entryKey(normalized)) return item
    if (item.infoHash && item.infoHash.toLowerCase() === hash) return item
    changed = true
    return { ...item, infoHash: hash }
  })

  if (changed) saveSavedEntries(updated)
}

function removeSavedEntry(entry) {
  const normalized = normalizeEntry(entry)
  if (!normalized) return false

  const key = entryKey(normalized)
  const entries = readSavedEntries().filter(item => entryKey(item) !== key)
  saveSavedEntries(entries)
  return true
}

function removeSavedEntriesByInfoHash(infoHash) {
  if (!infoHash) return []
  const target = String(infoHash).toLowerCase()
  const entries = readSavedEntries()
  const removed = []

  const filtered = entries.filter(item => {
    const entryHash = item.infoHash
      ? String(item.infoHash).toLowerCase()
      : (item.type === "magnet" ? infoHashFromMagnet(item.value) : null)
    if (entryHash && entryHash === target) {
      removed.push(item)
      return false
    }
    return true
  })

  if (removed.length > 0) {
    saveSavedEntries(filtered)
  }

  return removed
}

function createClient() {
  clientError = null
  const portToUse = portFallbackActive && settings.torrentPort !== 0
    ? 0
    : settings.torrentPort
  const peerId = buildPeerId()
  client = new WebTorrent({
    peerId,
    nodeId: crypto.randomBytes(20),
    torrentPort: portToUse,
    dhtPort: portToUse,
    natUpnp: false,
    natPmp: false
  })

  client.on("error", (err) => {
    const code = err?.code || (typeof err?.message === "string" && err.message.includes("EADDRINUSE")
      ? "EADDRINUSE"
      : null)

    if (!portFallbackActive && settings.torrentPort !== 0 && code === "EADDRINUSE") {
      portFallbackActive = true
      rebuildClient()
      return
    }

    if (settings.torrentPort !== 0 && code === "EACCES") {
      clientError = `Permission denied for port ${settings.torrentPort}. Try a higher port.`
    } else if (settings.torrentPort !== 0 && code === "EADDRINUSE") {
      clientError = `Port ${settings.torrentPort} is already in use.`
    } else {
      clientError = err?.message || "Unknown error"
    }

    console.error("WebTorrent error:", err)
    sendSettingsStatus()
  })

  client.on("listening", () => {
    sendSettingsStatus()
    applyPortForwarding()
  })
}

function destroyClientAsync() {
  return new Promise(resolve => {
    if (!client) return resolve()
    const current = client
    client = null
    try {
      current.destroy(() => resolve())
    } catch {
      resolve()
    }
  })
}

function destroyClient() {
  destroyClientAsync()
}

async function rebuildClient() {
  await destroyClientAsync()
  if (shuttingDown) return
  createClient()
  loadSavedTorrents()
}

function buildSettingsStatus() {
  const requestedPort = settings.torrentPort
  const actualPort = client ? client.torrentPort : settings.torrentPort
  let torrentPortError = null

  if (client && client.listening) {
    if (requestedPort !== 0 && actualPort !== requestedPort) {
      torrentPortError = `Port ${requestedPort} unavailable. Using ${actualPort}.`
    }
  }

  if (!torrentPortError && clientError) {
    torrentPortError = clientError
  }

  return {
    torrentPortRequested: requestedPort,
    torrentPortActual: actualPort,
    torrentPortError,
    portForwarding: portForwardingState,
    webUi: {
      enabled: settings.webUi.enabled,
      running: webServerState.running,
      host: webServerState.host,
      port: webServerState.port,
      error: webServerState.error
    }
  }
}

function sendSettingsStatus() {
  sendToRenderer("settings-status", buildSettingsStatus())
}

function sendUpdateStatus() {
  sendToRenderer("update-status", updateState)
}

function parseVersion(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/^v/i, "")
  const parts = cleaned.split(".").map(n => parseInt(n, 10)).filter(n => Number.isFinite(n))
  return parts.length ? parts : [0]
}

function compareVersions(a, b) {
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i += 1) {
    const left = a[i] || 0
    const right = b[i] || 0
    if (left > right) return 1
    if (left < right) return -1
  }
  return 0
}

function fetchLatestRelease() {
  return new Promise(resolve => {
    const options = {
      headers: {
        "User-Agent": "ZaynTorrentMonitor",
        "Accept": "application/vnd.github+json"
      },
      agent: httpsAgent
    }

    const req = https.get("https://api.github.com/repos/Zayncoder1/Zayn-Torrent-Monitor/releases/latest", options, (res) => {
      let data = ""
      res.on("data", chunk => { data += chunk })
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve(null)
          return
        }
        try {
          const json = JSON.parse(data)
          if (!json || json.draft || json.prerelease) {
            resolve(null)
            return
          }
          resolve(json)
        } catch {
          resolve(null)
        }
      })
    })

    req.on("error", () => resolve(null))
    req.setTimeout(5000, () => {
      req.destroy()
      resolve(null)
    })
  })
}

async function checkForUpdates() {
  if (shuttingDown) return
  const latest = await fetchLatestRelease()
  if (!latest || !latest.tag_name) {
    updateState.available = false
    sendUpdateStatus()
    return
  }

  const currentVersion = parseVersion(app.getVersion())
  const latestVersion = parseVersion(latest.tag_name)
  const available = compareVersions(latestVersion, currentVersion) > 0

  updateState = {
    available,
    latestVersion: latest.tag_name,
    url: updateState.url
  }

  sendUpdateStatus()
}

function startUpdateChecks() {
  if (updateCheckTimer) return
  checkForUpdates()
  updateCheckTimer = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS)
}

async function destroyPortForwarding() {
  if (!natClient) return
  const current = natClient
  natClient = null
  try {
    await current.destroy()
  } catch {
    // ignore
  }
}

async function applyPortForwarding() {
  if (portForwardingInFlight || shuttingDown) return
  portForwardingInFlight = true

  try {
    await destroyPortForwarding()
    portForwardingState = {
      torrent: {
        enabled: settings.portForwarding.torrent,
        active: false,
        error: null,
        port: null,
        note: null
      },
      webUi: {
        enabled: settings.portForwarding.webUi,
        active: false,
        error: null,
        port: null,
        note: null
      },
      externalIp: null
    }

    const anyEnabled = portForwardingState.torrent.enabled || portForwardingState.webUi.enabled
    if (!anyEnabled) {
      sendSettingsStatus()
      return
    }

    natClient = new NatAPI({ enableUPNP: true, enablePMP: true })

    const mappings = []

    if (portForwardingState.torrent.enabled) {
      const torrentPort = client && client.listening ? client.torrentPort : 0
      if (torrentPort) {
        portForwardingState.torrent.port = torrentPort
        mappings.push({
          target: "torrent",
          map: {
            publicPort: torrentPort,
            privatePort: torrentPort,
            protocol: null,
            description: "WebTorrent Torrent"
          }
        })
      } else {
        portForwardingState.torrent.note = "Waiting for torrent port..."
      }
    }

    if (portForwardingState.webUi.enabled) {
      if (!settings.webUi.enabled) {
        portForwardingState.webUi.note = "Enable Web UI to forward."
      } else if (!webServerState.running) {
        portForwardingState.webUi.note = "Web UI not running."
      } else if (webServerState.port) {
        portForwardingState.webUi.port = webServerState.port
        mappings.push({
          target: "webUi",
          map: {
            publicPort: webServerState.port,
            privatePort: webServerState.port,
            protocol: "TCP",
            description: "Web UI"
          }
        })
      } else {
        portForwardingState.webUi.note = "Waiting for Web UI port..."
      }
    }

    for (const item of mappings) {
      try {
        await natClient.map(item.map)
        if (item.target === "torrent") {
          portForwardingState.torrent.active = true
        } else {
          portForwardingState.webUi.active = true
        }
      } catch (err) {
        const msg = err?.message || "Port forwarding failed"
        if (item.target === "torrent") {
          portForwardingState.torrent.error = msg
        } else {
          portForwardingState.webUi.error = msg
        }
      }
    }

    if (portForwardingState.torrent.active || portForwardingState.webUi.active) {
      try {
        portForwardingState.externalIp = await natClient.externalIp()
      } catch {
        // ignore
      }
    }
  } catch (err) {
    const message = err?.message || "Port forwarding failed"
    portForwardingState = {
      torrent: {
        enabled: settings.portForwarding.torrent,
        active: false,
        error: message,
        port: null,
        note: null
      },
      webUi: {
        enabled: settings.portForwarding.webUi,
        active: false,
        error: message,
        port: null,
        note: null
      },
      externalIp: null
    }
  } finally {
    sendSettingsStatus()
    portForwardingInFlight = false
  }
}

function startWebUi() {
  webServerState = {
    running: false,
    host: settings.webUi.host,
    port: settings.webUi.port,
    error: null
  }

  if (!settings.webUi.enabled) {
    sendSettingsStatus()
    return
  }

  const server = http.createServer(handleWebUiRequest)
  webServer = server

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      webServerState.error = `Port ${settings.webUi.port} is already in use.`
    } else if (err.code === "EACCES") {
      webServerState.error = `Permission denied for port ${settings.webUi.port}.`
    } else {
      webServerState.error = err.message
    }
    webServerState.running = false
    try {
      server.close()
    } catch {
      // ignore
    }
    if (webServer === server) {
      webServer = null
    }
    sendSettingsStatus()
  })

  server.listen(settings.webUi.port, settings.webUi.host, () => {
    const address = server.address()
    if (address && typeof address === "object") {
      webServerState.port = address.port
      webServerState.host = address.address || settings.webUi.host
    }
    webServerState.running = true
    webServerState.error = null
    sendSettingsStatus()
    applyPortForwarding()
  })
}

function stopWebUi() {
  if (!webServer) {
    webServerState.running = false
    webServerState.error = null
    webServerState.host = settings.webUi.host
    webServerState.port = settings.webUi.port
    return
  }
  const server = webServer
  webServer = null
  try {
    server.close()
  } catch {
    // ignore
  }
  webServerState.running = false
  webServerState.error = null
  webServerState.host = settings.webUi.host
  webServerState.port = settings.webUi.port
  if (!shuttingDown) {
    applyPortForwarding()
  }
}

async function restartWebUi() {
  stopWebUi()
  startWebUi()
}

function handleWebUiRequest(req, res) {
  const url = new URL(req.url, "http://localhost")

  if (url.pathname === "/api/stats") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    })
    res.end(JSON.stringify(lastStats))
    return
  }

  if (url.pathname === "/") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    })
    res.end(getWebUiHtml())
    return
  }

  res.writeHead(404, { "Content-Type": "text/plain" })
  res.end("Not found")
}

function getWebUiHtml() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Zayn Torrent Monitor Web UI</title>
  <style>
    body {
      font-family: Arial;
      background: #0f172a;
      color: white;
      padding: 20px;
    }
    .panel {
      background: #1e293b;
      padding: 12px;
      border-radius: 10px;
      margin-bottom: 12px;
    }
    .stat {
      font-size: 14px;
      margin: 6px 0;
    }
    .tag {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 6px;
      font-size: 12px;
      margin-left: 6px;
      background: #334155;
    }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .torrent {
      border: 1px solid #334155;
      padding: 8px;
      border-radius: 8px;
      margin-bottom: 8px;
    }
    .progress {
      height: 8px;
      background: #334155;
      border-radius: 6px;
      overflow: hidden;
      margin-top: 6px;
    }
    .bar {
      height: 100%;
      background: #22c55e;
      width: 0%;
    }
  </style>
</head>
<body>
  <h1>Zayn Torrent Monitor (Web)</h1>
  <div class="panel">
    <div class="row">
      <div class="stat" id="status">Loading...</div>
      <div class="stat" id="totals"></div>
    </div>
  </div>
  <div class="panel">
    <h2>Torrents</h2>
    <div id="torrentList"></div>
  </div>
  <script>
    const statusEl = document.getElementById("status")
    const totalsEl = document.getElementById("totals")
    const listEl = document.getElementById("torrentList")

    function formatSpeed(bytes) {
      if (!bytes || bytes <= 0) return "0 KB/s"
      const kb = bytes / 1024
      if (kb < 1024) return kb.toFixed(1) + " KB/s"
      const mb = kb / 1024
      return mb.toFixed(2) + " MB/s"
    }

    async function refresh() {
      try {
        const res = await fetch("/api/stats", { cache: "no-store" })
        const data = await res.json()

        statusEl.textContent = data.isOnline ? "Online" : "Offline"
        statusEl.className = data.isOnline ? "stat" : "stat"

        totalsEl.textContent = "DL: " + formatSpeed(data.totalDownload) +
          " | UL: " + formatSpeed(data.totalUpload)

        listEl.innerHTML = ""
        data.torrents.forEach(t => {
          const div = document.createElement("div")
          div.className = "torrent"
          div.innerHTML =
            "<div><strong>" + t.name + "</strong>" +
            "<span class='tag'>" + t.status + "</span></div>" +
            "<div class='stat'>Peers: " + t.numPeers +
            " | DL: " + formatSpeed(t.downloadSpeed) +
            " | UL: " + formatSpeed(t.uploadSpeed) + "</div>" +
            "<div class='progress'><div class='bar' style='width:" + t.progress + "%'></div></div>"
          listEl.appendChild(div)
        })
      } catch {
        statusEl.textContent = "Error loading stats"
      }
    }

    refresh()
    setInterval(refresh, 1000)
  </script>
</body>
</html>`
}

function loadSavedTorrents() {

  if (!client || client.destroyed) return

  const savedEntries = readSavedEntries()

  const folderTorrents = fs.readdirSync(torrentFolder)
    .filter(f => f.endsWith(".torrent"))
    .map(f => ({ type: "file", value: f }))

  const merged = new Map()
  ;[...savedEntries, ...folderTorrents].forEach(item => {
    const normalized = normalizeEntry(item)
    if (!normalized) return
    merged.set(entryKey(normalized), normalized)
  })

  const all = Array.from(merged.values())
  saveSavedEntries(all)

  all.forEach(entry => {
    if (entry.type === "magnet") {
      loadTorrentMagnet(entry.value, entry)
    } else {
      loadTorrentFile(entry.value, entry)
    }
  })

}

function attachTorrentHandlers(torrent, entry) {
  if (torrent._zaynHandlersAttached) return
  torrent._zaynHandlersAttached = true

  torrent._zaynPaused = false
  torrent._zaynWires = new Set()
  if (entry) {
    torrent._zaynEntry = entry
    if (torrent.infoHash) {
      entry.infoHash = torrent.infoHash
      updateSavedEntryInfoHash(entry, torrent.infoHash)
    }
  }

  torrent.on("done", () => {
    if (!settings?.behavior?.autoSeed) {
      autoStopSeeding(torrent)
    }
  })

  torrent.on("wire", (wire) => {

    torrent._zaynWires.add(wire)
    wire._zaynSilent = torrent._zaynPaused

    if (!wire._zaynSilent) {

      sendToRenderer("peer-connected", {
        ip: wire.remoteAddress,
        port: wire.remotePort,
        torrent: torrent.name,
        time: new Date().toLocaleTimeString()
      })

    }

    wire.on("close", () => {

      torrent._zaynWires.delete(wire)

      if (!wire._zaynSilent) {

        sendToRenderer("peer-disconnected", {
          ip: wire.remoteAddress,
          port: wire.remotePort,
          torrent: torrent.name
        })

      }

    })

    if (torrent._zaynPaused) {
      wire.destroy()
    }

  })

  if (!settings?.behavior?.autoSeed && (torrent.progress === 1 || torrent.done)) {
    autoStopSeeding(torrent)
  }
}

function loadTorrentFile(file, entry) {

  if (!client || client.destroyed) return

  const torrentPath = path.join(torrentFolder, file)
  const finalEntry = entry || { type: "file", value: file }

  client.add(torrentPath, { path: downloadFolder }, torrent => {
    attachTorrentHandlers(torrent, finalEntry)
  })

}

function loadTorrentMagnet(magnet, entry) {

  if (!client || client.destroyed) return

  const finalEntry = entry || { type: "magnet", value: magnet }

  try {
    const existing = client.get(magnet)
    if (existing) {
      attachTorrentHandlers(existing, finalEntry)
      existing._zaynEntry = finalEntry
      return
    }
  } catch {
    // ignore
  }

  client.add(magnet, { path: downloadFolder }, torrent => {
    attachTorrentHandlers(torrent, finalEntry)
  })

}

function probeHttp(url) {

  return new Promise(resolve => {

    const target = new URL(url)
    const isHttps = target.protocol === "https:"
    const requestFn = isHttps ? https.get : http.get
    const options = isHttps ? { agent: httpsAgent } : {}

    const req = requestFn(url, options, (res) => {

      res.resume()

      const code = res.statusCode || 0
      resolve(code >= 200 && code < 500)

    })

    req.on("error", () => resolve(false))

    req.setTimeout(CHECK_TIMEOUT_MS, () => {
      req.destroy()
      resolve(false)
    })

  })

}

function probeTcp(host, port) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port })

    const finish = (result) => {
      try {
        socket.destroy()
      } catch {
        // ignore
      }
      resolve(result)
    }

    socket.setTimeout(CHECK_TIMEOUT_MS)

    socket.on("connect", () => finish(true))
    socket.on("error", () => finish(false))
    socket.on("timeout", () => finish(false))
  })
}

async function probeTcpAny() {
  const results = await Promise.all(
    TCP_PROBES.map(target => probeTcp(target.host, target.port))
  )
  return results.some(Boolean)
}

function hasExternalInterface() {
  const nets = os.networkInterfaces()
  const entries = Object.values(nets).flat().filter(Boolean)
  return entries.some(info => {
    if (info.internal) return false
    const addr = info.address || ""
    if (!addr) return false
    if (info.family === "IPv4") {
      if (addr === "0.0.0.0") return false
      if (addr.startsWith("169.254.")) return false
      return true
    }
    if (info.family === "IPv6") {
      const lower = addr.toLowerCase()
      if (lower === "::1") return false
      if (lower.startsWith("fe80:")) return false
      return true
    }
    return false
  })
}

async function probeDnsAny() {

  const results = await Promise.allSettled(
    PROBE_DNS.map(host => dns.promises.resolve(host))
  )

  return results.some(r => r.status === "fulfilled")

}

async function probeHttpAny() {

  const results = await Promise.all(
    PROBE_URLS.map(url => probeHttp(url))
  )

  return results.some(Boolean)

}

async function checkInternet() {

  if (checkInFlight) return internetState
  checkInFlight = true

  try {

    if (!hasExternalInterface()) return false

    const [httpOk, tcpOk] = await Promise.all([
      probeHttpAny(),
      probeTcpAny()
    ])

    return httpOk || tcpOk

  } finally {

    checkInFlight = false

  }

}

function sendStats() {

  if (shuttingDown) return

  let totalDownload = 0
  let totalUpload = 0

  const torrents = client && !client.destroyed ? client.torrents.map(t => {

    totalDownload += t.downloadSpeed
    totalUpload += t.uploadSpeed

    let status = "Downloading"

    if (!internetState) status = "Error"
    else if (t.progress === 1 && !settings?.behavior?.autoSeed) status = "Completed"
    else if (t.paused) status = "Paused"
    else if (t.progress === 1) status = "Seeding"

    return {
      name: t.name,
      infoHash: t.infoHash,
      progress: (t.progress * 100).toFixed(2),
      downloadSpeed: t.downloadSpeed,
      uploadSpeed: t.uploadSpeed,
      numPeers: t.numPeers,
      status: status
    }

  }) : []

  lastStats = {
    torrents,
    isOnline: internetState,
    totalDownload,
    totalUpload
  }

  sendToRenderer("stats", lastStats)

}

function sendToRenderer(channel, payload) {
  if (!win || win.isDestroyed()) return
  if (!win.webContents || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

function getTrayIcon() {
  const dataUrl =
    "data:image/png;base64," +
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAi0lEQVR4AWP4" +
    "z8DAwMDAmGdgYGBgkCkMDAwMDAwMZkB+gWJgYGBgWGFoQkYB4eHh4eHh/8Z" +
    "wP///4YGDgYGJiYmJgYGBgYGDkA2QEMkNQ4mQkA0EoS4lGQkB2QkA0EoS4l" +
    "GQkB2QkA0EoS4lGQkB2QkA0P8B2wEJ6pQeZ2oAAAAASUVORK5CYII="

  const image = nativeImage.createFromDataURL(dataUrl)
  return image.isEmpty() ? nativeImage.createEmpty() : image
}

function updateTrayState() {
  try {
    if (settings?.behavior?.backgroundOnClose) {
      if (!tray) {
        tray = new Tray(getTrayIcon())
        const contextMenu = Menu.buildFromTemplate([
          {
            label: "Show",
            click: () => {
              if (win) {
                win.show()
                win.focus()
              } else {
                createWindow()
              }
            }
          },
          {
            label: "Quit",
            click: () => {
              shutdownAndExit(0)
            }
          }
        ])
        tray.setToolTip("Zayn Torrent Monitor")
        tray.setContextMenu(contextMenu)
        tray.on("click", () => {
          if (!win) {
            createWindow()
            return
          }
          if (win.isVisible()) win.hide()
          else {
            win.show()
            win.focus()
          }
        })
      }
    } else if (tray) {
      tray.destroy()
      tray = null
    }
  } catch (err) {
    console.error("Tray init failed:", err)
  }
}

function autoStopSeeding(torrent) {
  if (!torrent || torrent._zaynAutoStopped) return
  torrent._zaynAutoStopped = true
  torrent._zaynPaused = true
  try {
    torrent.pause()
  } catch {
    // ignore
  }
  if (torrent._zaynWires && torrent._zaynWires.size > 0) {
    Array.from(torrent._zaynWires).forEach(wire => {
      try {
        wire.destroy()
      } catch {
        // ignore
      }
    })
  }
}

function getTorrentOpenTarget(torrent) {
  if (!torrent) return null
  const basePath = path.resolve(torrent.path || downloadFolder)
  if (Array.isArray(torrent.files) && torrent.files.length > 0) {
    const filePath = path.resolve(basePath, torrent.files[0].path)
    return { type: "file", path: filePath }
  }
  return { type: "folder", path: basePath }
}

function findTorrentById(id) {
  if (!client || client.destroyed) return null
  try {
    return client.get(id) || client.torrents.find(t => t.infoHash === id || t.name === id)
  } catch {
    return client.torrents.find(t => t.infoHash === id || t.name === id)
  }
}

ipcMain.on("pause-torrent", (event, name) => {

  if (!client || client.destroyed) return

  const torrent = findTorrentById(name)

  if (!torrent) return

  torrent._zaynPaused = true
  torrent.pause()

  if (torrent._zaynWires && torrent._zaynWires.size > 0) {
    Array.from(torrent._zaynWires).forEach(wire => {
      try {
        wire.destroy()
      } catch {
        // ignore
      }
    })
  }

})

ipcMain.on("resume-torrent", (event, name) => {

  if (!client || client.destroyed) return

  const torrent = findTorrentById(name)

  if (!torrent) return

  torrent._zaynAutoStopped = false
  torrent._zaynPaused = false
  torrent.resume()

})

ipcMain.handle("get-settings", () => {
  return {
    settings,
    status: buildSettingsStatus()
  }
})

ipcMain.handle("save-settings", async (event, incoming) => {
  settings = normalizeSettings(incoming)
  saveSettings(settings)

  portFallbackActive = false
  await rebuildClient()
  await restartWebUi()
  await applyPortForwarding()
  updateTrayState()

  const payload = {
    settings,
    status: buildSettingsStatus()
  }

  sendSettingsStatus()
  return payload
})

ipcMain.handle("show-in-folder", (event, infoHash) => {
  if (!client || client.destroyed) {
    return { ok: false, message: "Client not ready yet." }
  }

  const torrent = findTorrentById(infoHash)
  if (!torrent) {
    return { ok: false, message: "Torrent not found." }
  }

  const target = getTorrentOpenTarget(torrent)
  if (!target) {
    return { ok: false, message: "Download path not available." }
  }

  try {
    if (target.type === "file") {
      shell.showItemInFolder(target.path)
    } else {
      shell.openPath(target.path)
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err?.message || "Failed to open download folder." }
  }
})

ipcMain.handle("add-magnet", (event, magnet) => {
  if (!client || client.destroyed) {
    return { ok: false, message: "Client not ready yet." }
  }

  const value = typeof magnet === "string" ? magnet.trim() : ""
  if (!value.startsWith("magnet:")) {
    return { ok: false, message: "Invalid magnet link." }
  }

  const added = addSavedEntry({ type: "magnet", value })

  try {
    if (!client.get(value)) {
      loadTorrentMagnet(value)
    }
  } catch {
    loadTorrentMagnet(value)
  }

  return {
    ok: true,
    message: added ? "Magnet added." : "Magnet already saved."
  }
})

ipcMain.handle("add-torrent-paths", (event, paths) => {
  if (!client || client.destroyed) {
    return { ok: false, message: "Client not ready yet." }
  }

  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, message: "No files selected." }
  }

  let addedCount = 0
  let skippedCount = 0

  paths.forEach(filePath => {
    if (typeof filePath !== "string") return
    if (!filePath.toLowerCase().endsWith(".torrent")) return

    const fileName = path.basename(filePath)
    const targetPath = path.join(torrentFolder, fileName)

    try {
      if (!fs.existsSync(targetPath)) {
        fs.copyFileSync(filePath, targetPath)
      } else {
        skippedCount++
      }
    } catch {
      skippedCount++
      return
    }

    const added = addSavedEntry({ type: "file", value: fileName })
    if (added) {
      addedCount++
      loadTorrentFile(fileName)
    }
  })

  if (addedCount === 0 && skippedCount > 0) {
    return { ok: true, message: "Torrent file(s) already added." }
  }

  return {
    ok: true,
    message: `Added ${addedCount} torrent file(s).`
  }
})

ipcMain.handle("remove-torrent", async (event, payload) => {
  if (!client || client.destroyed) {
    return { ok: false, message: "Client not ready yet." }
  }

  const infoHash = payload?.infoHash || payload?.name
  if (typeof infoHash !== "string" || infoHash.trim().length === 0) {
    return { ok: false, message: "Missing torrent id." }
  }

  const torrentId = infoHash.trim()
  const torrent = findTorrentById(torrentId)
  if (!torrent) {
    return { ok: false, message: "Torrent not found." }
  }

  const removeContent = !!payload?.removeContent

  const entry = torrent._zaynEntry
  const removedEntries = removeSavedEntriesByInfoHash(torrent.infoHash || torrentId)

  if (entry) {
    removeSavedEntry(entry)
  }

  const deleteEntryFile = (item) => {
    if (item?.type !== "file") return
    const filePath = path.join(torrentFolder, item.value)
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    } catch {
      // ignore
    }
  }

  if (entry) deleteEntryFile(entry)
  removedEntries.forEach(deleteEntryFile)

  try {
    const id = torrent.infoHash || torrentId
    await new Promise((resolve, reject) => {
      client.remove(id, { destroyStore: removeContent }, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  } catch (err) {
    return { ok: false, message: err?.message || "Failed to remove torrent." }
  }

  return {
    ok: true,
    message: removeContent ? "Torrent removed and content deleted." : "Torrent removed."
  }
})
