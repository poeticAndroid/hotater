const ws = require("ws")

const wss = new ws.WebSocketServer({ noServer: true })

const topics = {}

wss.on('connection', function connection(ws) {
    ws.on('error', console.error)
    ws.on('open', () => {
        console.log("connection open")
    })

    ws.on('message', (data) => {
        if (!(data = parseJSON(data))) ws.close(1002, "bad json")
        console.log('message: %s', JSON.stringify(data))
        send({ echo: data })
    })

    ws.on('close', (code, reason) => {
        console.log('closed: %d %s', code, reason)
    })

    function send(message, type = "idk", success = true) {
        message.type = type
        message.success = success
        ws.send(JSON.stringify(message))
    }
})

function parseJSON(json) {
    try { return JSON.parse(json) } catch (error) { }
}

module.exports = wss