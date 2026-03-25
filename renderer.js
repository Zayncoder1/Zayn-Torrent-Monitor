const { ipcRenderer } = require("electron")

const torrentBox = document.getElementById("torrents")
const connectionBox = document.getElementById("connections")
const internetStatus = document.getElementById("internetStatus")
const systemStatus = document.getElementById("systemStatus")

const magnetInput = document.getElementById("magnetInput")
const addMagnetBtn = document.getElementById("addMagnetBtn")
const torrentFileInput = document.getElementById("torrentFileInput")
const addTorrentFileBtn = document.getElementById("addTorrentFileBtn")
const addStatus = document.getElementById("addStatus")

const settingsButton = document.getElementById("settingsButton")
const settingsModal = document.getElementById("settingsModal")
const settingsClose = document.getElementById("settingsClose")
const settingsSave = document.getElementById("settingsSave")
const settingsStatus = document.getElementById("settingsStatus")
const webUiStatus = document.getElementById("webUiStatus")
const torrentPortActual = document.getElementById("torrentPortActual")
const portForwardingStatusTorrent = document.getElementById("portForwardingStatusTorrent")
const portForwardingStatusWebUi = document.getElementById("portForwardingStatusWebUi")

const settingTorrentPort = document.getElementById("settingTorrentPort")
const settingPortForwardingTorrent = document.getElementById("settingPortForwardingTorrent")
const settingPortForwardingWebUi = document.getElementById("settingPortForwardingWebUi")
const settingWebUiEnabled = document.getElementById("settingWebUiEnabled")
const settingWebUiHost = document.getElementById("settingWebUiHost")
const settingWebUiPort = document.getElementById("settingWebUiPort")
const settingAutoSeed = document.getElementById("settingAutoSeed")

const removeModal = document.getElementById("removeModal")
const removeClose = document.getElementById("removeClose")
const removeCancel = document.getElementById("removeCancel")
const removeConfirm = document.getElementById("removeConfirm")
const removeText = document.getElementById("removeText")
const removeContentCheckbox = document.getElementById("removeContentCheckbox")

const tabButtons = Array.from(document.querySelectorAll(".tab-button"))
const tabPanels = {
    torrent: document.getElementById("tab-torrent"),
    webui: document.getElementById("tab-webui"),
    behavior: document.getElementById("tab-behavior")
}

const canvas = document.getElementById("speedGraph")
const ctx = canvas.getContext("2d")

const torrents = {}
const torrentPaused = {}
const torrentInfoByHash = {}

const MAX_CONNECTION_LINES = 10

let downloadHistory = []
let uploadHistory = []
const MAX_POINTS = 120

let lastSettingsStatus = null
let addStatusTimer = null
let pendingRemoveHash = null

function drawGraph() {

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    const step = canvas.width / MAX_POINTS

    ctx.beginPath()

    ctx.strokeStyle = "#22c55e"

    downloadHistory.forEach((v, i) => {

        const x = i * step
        const y = canvas.height - v

        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)

    })

    ctx.stroke()

    ctx.beginPath()

    ctx.strokeStyle = "#38bdf8"

    uploadHistory.forEach((v, i) => {

        const x = i * step
        const y = canvas.height - v

        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)

    })

    ctx.stroke()

}

function addConnectionLine(text) {

    const msg = document.createElement("div")

    msg.className = "connection"
    msg.textContent = text

    connectionBox.prepend(msg)

    while (connectionBox.children.length > MAX_CONNECTION_LINES) {
        connectionBox.removeChild(connectionBox.lastChild)
    }

}

ipcRenderer.on("stats", (event, data) => {

    const { torrents: list, isOnline, totalDownload, totalUpload } = data

    if (!isOnline) {

        internetStatus.textContent = "ERROR: No Internet Connection"
        internetStatus.style.background = "red"

    } else {

        internetStatus.textContent = "Online"
        internetStatus.style.background = "#22c55e"

    }

    const dl = totalDownload / 50000
    const ul = totalUpload / 50000

    downloadHistory.push(dl)
    uploadHistory.push(ul)

    if (downloadHistory.length > MAX_POINTS) downloadHistory.shift()
    if (uploadHistory.length > MAX_POINTS) uploadHistory.shift()

    drawGraph()

    const activeIds = new Set()

    list.forEach(t => {

        const id = t.infoHash || t.name
        activeIds.add(id)
        torrentInfoByHash[id] = t

        if (!torrents[id]) {

            const container = document.createElement("div")
            container.id = "torrent-" + id

            container.innerHTML = `

<h3>${t.name}</h3>

<div>Status: <span id="status-${id}"></span></div>

<div class="progress">
<div class="bar" id="bar-${id}"></div>
</div>

<div id="stats-${id}"></div>

<button id="toggle-${id}" onclick="toggleTorrent('${id}')">Pause</button>
<button id="open-${id}" onclick="openTorrent('${id}')">Go to file</button>
<button class="danger" onclick="confirmRemove('${id}')">Remove</button>

`

            torrentBox.appendChild(container)

            torrents[id] = true

        }

        const bar = document.getElementById("bar-" + id)
        if (bar) bar.style.width = t.progress + "%"

        const stats = document.getElementById("stats-" + id)

        stats.textContent =
            `Peers: ${t.numPeers} | DL: ${(t.downloadSpeed / 1024).toFixed(1)} KB/s | UL: ${(t.uploadSpeed / 1024).toFixed(1)} KB/s`

        const status = document.getElementById("status-" + id)

        status.textContent = t.status

        if (t.status === "Error") status.style.color = "red"
        else if (t.status === "Paused") status.style.color = "orange"
        else if (t.status === "Completed") status.style.color = "#38bdf8"
        else if (t.status === "Seeding") status.style.color = "lime"
        else status.style.color = "white"

        torrentPaused[id] = t.status === "Paused" || t.status === "Completed"

        const toggle = document.getElementById("toggle-" + id)
        if (toggle) toggle.textContent = torrentPaused[id] ? "Resume" : "Pause"

    })

    Object.keys(torrents).forEach(id => {
        if (!activeIds.has(id)) {
            const el = document.getElementById("torrent-" + id)
            if (el && el.parentElement) el.parentElement.removeChild(el)
            delete torrents[id]
            delete torrentPaused[id]
            delete torrentInfoByHash[id]
        }
    })

})

ipcRenderer.on("peer-connected", (event, data) => {

    addConnectionLine(
        `Connected ${data.ip}:${data.port} → ${data.torrent}`
    )

})

ipcRenderer.on("peer-disconnected", (event, data) => {

    addConnectionLine(
        `Disconnected ${data.ip}:${data.port} → ${data.torrent}`
    )

})

function toggleTorrent(name) {
    if (torrentPaused[name]) {
        ipcRenderer.send("resume-torrent", name)
    } else {
        ipcRenderer.send("pause-torrent", name)
    }
}

async function openTorrent(infoHash) {
    const result = await ipcRenderer.invoke("show-in-folder", infoHash)
    if (!result?.ok) {
        setAddStatus(result?.message || "Failed to open download folder.", true)
    }
}

function setAddStatus(text, isError) {
    if (!addStatus) return
    addStatus.textContent = text || ""
    addStatus.style.color = isError ? "#fca5a5" : "#94a3b8"

    if (addStatusTimer) clearTimeout(addStatusTimer)
    if (text) {
        addStatusTimer = setTimeout(() => {
            addStatus.textContent = ""
        }, 4000)
    }
}

function openRemoveModal(infoHash) {
    const t = torrentInfoByHash[infoHash]
    if (!t || !removeModal) return

    pendingRemoveHash = infoHash
    removeText.textContent = `Remove "${t.name}"?`
    if (removeContentCheckbox) removeContentCheckbox.checked = false
    removeModal.classList.remove("hidden")
}

function closeRemoveModal() {
    pendingRemoveHash = null
    if (removeModal) removeModal.classList.add("hidden")
}

function confirmRemove(infoHash) {
    openRemoveModal(infoHash)
}

async function executeRemove() {
    if (!pendingRemoveHash) return
    const removeContent = !!removeContentCheckbox?.checked
    const result = await ipcRenderer.invoke("remove-torrent", {
        infoHash: pendingRemoveHash,
        removeContent
    })

    if (result?.ok) {
        setAddStatus(result.message || "Torrent removed.", false)
    } else {
        setAddStatus(result?.message || "Failed to remove torrent.", true)
    }

    closeRemoveModal()
}

function setActiveTab(tabName) {
    tabButtons.forEach(btn => {
        const active = btn.dataset.tab === tabName
        btn.classList.toggle("active", active)
    })

    Object.entries(tabPanels).forEach(([key, panel]) => {
        if (!panel) return
        panel.classList.toggle("active", key === tabName)
    })
}

function updateSettingsStatus(status) {
    lastSettingsStatus = status

    if (!status) return

    let mainError = null

    if (status.torrentPortError) {
        torrentPortActual.textContent = status.torrentPortError
        torrentPortActual.style.color = "red"
        mainError = `Torrent port: ${status.torrentPortError}`
    } else {
        const actual = status.torrentPortActual
        const requested = status.torrentPortRequested
        if (typeof actual === "number" && actual > 0 && requested === 0) {
            torrentPortActual.textContent = `Actual port: ${actual}`
        } else if (typeof actual === "number" && actual > 0 && requested !== actual) {
            torrentPortActual.textContent = `Actual port: ${actual}`
        } else {
            torrentPortActual.textContent = ""
        }
        torrentPortActual.style.color = "#94a3b8"
    }

    if (status.webUi) {
        const { running, host, port, error, enabled } = status.webUi
        if (enabled && running) {
            webUiStatus.textContent = `Running at http://${host}:${port}`
        } else if (enabled && error) {
            webUiStatus.textContent = `Error: ${error}`
            if (!mainError) {
                mainError = `Web UI: ${error}`
            }
        } else if (enabled) {
            webUiStatus.textContent = "Starting..."
        } else {
            webUiStatus.textContent = "Disabled"
        }
    }

    if (status.portForwarding) {
        const pf = status.portForwarding
        const ext = pf.externalIp ? ` | External IP: ${pf.externalIp}` : ""

        const renderPf = (pfItem, el, label) => {
            if (!el || !pfItem) return null
            if (!pfItem.enabled) {
                el.textContent = "Disabled"
                return null
            }
            if (pfItem.error) {
                el.textContent = `Error: ${pfItem.error}`
                return `${label}: ${pfItem.error}`
            }
            if (pfItem.active) {
                const portText = pfItem.port ? `Port: ${pfItem.port}` : "Port mapped"
                el.textContent = `Active. ${portText}${ext}`
                return null
            }
            if (pfItem.note) {
                el.textContent = pfItem.note
                return null
            }
            el.textContent = "Enabled, waiting for port..."
            return null
        }

        const torrentError = renderPf(pf.torrent, portForwardingStatusTorrent, "Port forwarding (torrent)")
        const webUiError = renderPf(pf.webUi, portForwardingStatusWebUi, "Port forwarding (web UI)")

        if (!mainError && torrentError) mainError = torrentError
        if (!mainError && webUiError) mainError = webUiError
    }

    if (systemStatus) {
        if (mainError) {
            systemStatus.textContent = mainError
            systemStatus.style.display = "block"
        } else {
            systemStatus.textContent = ""
            systemStatus.style.display = "none"
        }
    }
}

function fillSettingsForm(settings, status) {
    if (!settings) return

    settingTorrentPort.value = settings.torrentPort
    settingPortForwardingTorrent.checked = settings.portForwarding?.torrent ?? true
    settingPortForwardingWebUi.checked = settings.portForwarding?.webUi ?? false
    settingWebUiEnabled.checked = settings.webUi?.enabled ?? false
    settingWebUiHost.value = settings.webUi?.host ?? "0.0.0.0"
    settingWebUiPort.value = settings.webUi?.port ?? 80
    if (settingAutoSeed) {
        settingAutoSeed.checked = settings.behavior?.autoSeed ?? false
    }

    updateSettingsStatus(status)
}

async function openSettings() {
    setActiveTab("torrent")
    settingsModal.classList.remove("hidden")

    const data = await ipcRenderer.invoke("get-settings")
    fillSettingsForm(data.settings, data.status)
}

function closeSettings() {
    settingsModal.classList.add("hidden")
}

async function saveSettings() {
    const newSettings = {
        torrentPort: Number(settingTorrentPort.value),
        portForwarding: {
            torrent: settingPortForwardingTorrent.checked,
            webUi: settingPortForwardingWebUi.checked
        },
        webUi: {
            enabled: settingWebUiEnabled.checked,
            host: settingWebUiHost.value.trim() || "0.0.0.0",
            port: Number(settingWebUiPort.value)
        },
        behavior: {
            autoSeed: settingAutoSeed?.checked ?? false
        }
    }

    settingsStatus.textContent = "Saving..."

    const data = await ipcRenderer.invoke("save-settings", newSettings)
    fillSettingsForm(data.settings, data.status)

    settingsStatus.textContent = "Saved"
    setTimeout(() => {
        settingsStatus.textContent = ""
    }, 1500)
}

if (settingsButton) {
    settingsButton.addEventListener("click", openSettings)
}

if (settingsClose) {
    settingsClose.addEventListener("click", closeSettings)
}

if (settingsSave) {
    settingsSave.addEventListener("click", saveSettings)
}

if (removeClose) {
    removeClose.addEventListener("click", closeRemoveModal)
}

if (removeCancel) {
    removeCancel.addEventListener("click", closeRemoveModal)
}

if (removeConfirm) {
    removeConfirm.addEventListener("click", executeRemove)
}

tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
        setActiveTab(btn.dataset.tab)
    })
})

ipcRenderer.on("settings-status", (event, status) => {
    updateSettingsStatus(status)
})

if (addMagnetBtn) {
    addMagnetBtn.addEventListener("click", async () => {
        const value = (magnetInput?.value || "").trim()
        if (!value || !value.startsWith("magnet:")) {
            setAddStatus("Please enter a valid magnet link.", true)
            return
        }

        const result = await ipcRenderer.invoke("add-magnet", value)
        if (result?.ok) {
            setAddStatus(result.message || "Magnet added.", false)
            if (magnetInput) magnetInput.value = ""
        } else {
            setAddStatus(result?.message || "Failed to add magnet.", true)
        }
    })
}

if (magnetInput) {
    magnetInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault()
            addMagnetBtn?.click()
        }
    })
}

if (addTorrentFileBtn && torrentFileInput) {
    addTorrentFileBtn.addEventListener("click", () => {
        torrentFileInput.click()
    })

    torrentFileInput.addEventListener("change", async () => {
        const files = Array.from(torrentFileInput.files || [])
        if (files.length === 0) return

        const paths = files.map(file => file.path).filter(Boolean)
        const result = await ipcRenderer.invoke("add-torrent-paths", paths)
        if (result?.ok) {
            setAddStatus(result.message || "Torrent file(s) added.", false)
        } else {
            setAddStatus(result?.message || "Failed to add torrent file(s).", true)
        }

        torrentFileInput.value = ""
    })
}
