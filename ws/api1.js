const ws = require("ws")
const crypto = require("crypto")

const wss = new ws.WebSocketServer({ noServer: true })

const topics = {}

wss.on('connection', function connection(ws) {
    let id
    let room

    ws.on('error', console.error)
    ws.on('open', () => {
        console.log("connection open")
        send({ id: newId() }, "id")
    })

    ws.on('message', (data) => {
        if (data.length > 1024 * 64) ws.close(1002, "too much!")
        console.log('message: %s', data)
        if (!(data = parseJSON(data))) ws.close(1002, "bad json")

        send({ echo: data })
    })

    ws.on('close', (code, reason) => {
        console.log('closed: %d %s', code, reason)
    })

    function send(message, type = "idk", success = true) {
        message.id = newId()
        message.type = type
        message.success = success
        ws.send(JSON.stringify(message))
    }
})

function parseJSON(json) {
    try { return JSON.parse(json) } catch (error) { }
}

const _idHash = crypto.createHash("sha256")
function newId() {
    _idHash.update("?" + Date.now() + "&" + Math.random())
    return _idHash.digest("base64url")
}

module.exports = wss