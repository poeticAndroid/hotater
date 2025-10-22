const ws = require("ws")
const crypto = require("crypto")

const wss = new ws.WebSocketServer({ noServer: true })

const users = {}
const topics = {}

wss.on('connection', (ws, req) => {
    let id = newId()
    let user, topic, room

    ws.on('error', console.error)

    ws.on('message', (msg) => {
        let r
        if (msg.length > 1024 * 64) return ws.close(1009, "too much!")
        // console.log('message: %s', msg)
        if (!(msg = parseJSON(msg))) return ws.close(1007, "bad json")

        switch (msg.type) {
            case "user":
                if (!msg.name) return ws.close(1002, "bad user")
                if (typeof msg.name != "string") return ws.close(1002, "bad user")

                users[id] = user = msg
                send({ id: id }, "id")
                break;

            case "topic":
                if (!user) return ws.close(1002, "no user")
                if (!msg.name) return ws.close(1002, "bad topic")
                if (typeof msg.name != "string") return ws.close(1002, "bad topic")

                topic = topics[msg.name] = topics[msg.name] || {}
                r = []
                for (let id in topic) {
                    let room = topic[id]
                    if (room.private) continue
                    if (!room.open) continue
                    let count = 0
                    for (let user in room.users) {
                        if (room.users[user]?.readyState === WebSocket.OPEN) count++
                        else delete room.users[user]
                    }
                    if (!count) {
                        delete topic[id]
                        continue
                    }
                    r.push({ id: id, name: room.name, creator: users[room.creator] })
                }
                send({ rooms: r }, "rooms")
                break;

            case "room":
                if (!topic) return ws.close(1002, "no topic")

                if (room) {
                    if (room.creator != id) return ws.close(1008, "unauthorized")
                    for (let key of ["open", "private"])
                        if (msg[key] !== undefined) room[key] = msg[key]
                } else if (msg.id) {
                    room = topic[msg.id]
                    if (!room?.open) return ws.close(1002, "bad room")
                } else if (msg.name) {
                    room = { name: msg.name, creator: id, users: {}, open: true }
                    topic[newId()] = room
                } else {
                    return ws.close(1002, "bad room")
                }
                room.users[id] = ws
                r = { name: room.name, creator: room.creator, open: room.open, private: room.private, users: {} }

                send(r, "room")
                break;

            case "msg":
                if (!room) return ws.close(1002, "no room")
                if (!msg.to) return ws.close(1002, "bad to")

                msg.from = id
                if (room.users[msg.to]?.readyState === WebSocket.OPEN) {
                    room.users[msg.to].send(JSON.stringify(msg))
                } else if (msg.to == "all") {
                    for (let user in room.users) {
                        if (room.users[user]?.readyState === WebSocket.OPEN) {
                            room.users[user].send(JSON.stringify(msg))
                        } else {
                            delete room.users[user]
                        }
                    }
                } else if (msg.to == "others") {
                    for (let user in room.users) {
                        if (room.users[user]?.readyState === WebSocket.OPEN) {
                            if (user != id) room.users[user].send(JSON.stringify(msg))
                        } else {
                            delete room.users[user]
                        }
                    }
                } else {
                    delete room.users[msg.to]
                }
                break;


            case "kick":
                if (!room) return ws.close(1002, "no room")
                if (room.creator != id) return ws.close(1008, "unauthorized")

                if (room.users[msg.id]?.readyState === WebSocket.OPEN) room.users[msg.id].close(1008, "kicked")
                delete room.users[msg.id]
                break;

            default:
                return ws.close(1002, "bad type")
                break;
        }
    })

    ws.on('close', (code, reason) => {
        console.log('closed: %d %s', code, reason)

        delete users[id]
        if (room) delete room.users[id]
    })

    function send(msg, type = "msg", success = true) {
        msg.id = newId()
        msg.type = type
        msg.success = success
        ws.send(JSON.stringify(msg))
    }
})

function parseJSON(json) {
    try { return JSON.parse(json) } catch (error) { }
}

let _idHash = "Vau1giFtLn_vsv12gQXe6Mn7rgvJ4NnEJ122JxpDfvE"
function newId() {
    let hash = crypto.createHash("sha256")
    hash.update(_idHash + "?" + Date.now() + "&" + Math.random())
    return _idHash = hash.digest("base64url")
}

module.exports = wss