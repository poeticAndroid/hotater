const ws = require("ws")
const crypto = require("crypto")

const wss = new ws.WebSocketServer({ noServer: true })

const topics = {}

let hostname = "localhost"

wss.on('connection', (ws, req) => {
    hostname = req?.headers?.host || hostname

    let user, topic, room

    ws.on('error', console.error)

    ws.on('message', (msg) => {
        if (msg.length > 1024 * 64) return ws.close(1009, "too much!")
        // console.log('message: %s', msg)
        if (!(msg = parseJSON(msg))) return ws.close(1007, "bad json")

        switch (msg.type) {
            case "ping":
                msg.to = user?.id
                send(msg)
                break;

            case "user":
                if (user) return ws.close(1002, "already user")
                if (!msg.name) return ws.close(1002, "bad user")
                if (typeof msg.name != "string") return ws.close(1002, "bad user")

                user = {
                    type: "user",
                    id: newId(),
                    name: msg.name,
                    meta: msg.meta,
                    _ws: ws
                }
                send(user)
                break;

            case "topic":
                if (!user) return ws.close(1002, "no user")
                if (topic) return ws.close(1002, "already topic")
                if (!msg.key) return ws.close(1002, "bad topic")
                if (typeof msg.key != "string") return ws.close(1002, "bad topic")

                topic = {
                    type: "topic",
                    _key: dehash(user, msg.key),
                    rooms: {}
                }
                topic = topics[topic._key] = topics[topic._key] || topic

                for (let id in topic.rooms) {
                    let room = topic.rooms[id]
                    let count = 0
                    for (let user in room.users) {
                        if (room.users[user]?._ws?.readyState === WebSocket.OPEN) count++
                        else delete room.users[user]
                    }
                    if (!count) {
                        delete topic.rooms[id]
                        continue
                    }
                }
                send(topic)
                break;

            case "room":
                if (!topic) return ws.close(1002, "no topic")

                if (room) {
                    if (room.creator != user.id) return ws.close(1008, "unauthorized")
                    if (msg.open !== undefined) room.open = msg.open
                    if (msg.meta !== undefined) room.meta = msg.meta
                    if (room.open) topic.rooms[room.id] = room
                    else delete topic.rooms[room.id]
                } else if (msg.id) {
                    room = topic.rooms[msg.id]
                    if (!room?.open) return ws.close(1002, "bad room")
                    console.log(user.name, "joined room", room.name)
                } else if (msg.name) {
                    room = {
                        type: "room", id: newId(), name: msg.name, meta: msg.meta,
                        creator: user.id, open: true, private: msg.private, users: {}
                    }
                    if (room.private) while (room.id.slice(0, 1) != "_") room.id = "_" + room.id
                    else while (room.id.slice(0, 1) == "_") room.id = room.id.slice(1)
                    topic.rooms[room.id] = room
                    console.log(user.name, "created room", room.name)
                } else {
                    return ws.close(1002, "bad room")
                }
                room.users[user.id] = user

                send(room)
                break;

            case "msg":
                if (!room) return ws.close(1002, "no room")
                if (!msg.to) return ws.close(1002, "bad to")

                msg.from = user.id
                send(msg, msg.to == "others" ? user.id : null)
                break;


            case "kick":
                if (!room) return ws.close(1002, "no room")
                if (room.creator != user.id) return ws.close(1008, "unauthorized")

                if (room.users[msg.id]?._ws?.readyState === WebSocket.OPEN) room.users[msg.id]._ws.close(1008, "kicked")
                delete room.users[msg.id]
                break;

            default:
                return ws.close(1002, "bad type")
                break;
        }
    })

    ws.on('close', (code, reason) => {
        if (room) {
            delete room.users[user.id]
            send(room)
        }
    })

    function send(msg, except) {
        if (room) {
            if (room.users[msg.to]?._ws?.readyState === WebSocket.OPEN)
                room.users[msg.to]._ws.send(stringifyJSON(msg))
            else for (let user in room.users) {
                if (room.users[user]?._ws?.readyState === WebSocket.OPEN) {
                    if (user != except) room.users[user]._ws.send(stringifyJSON(msg))
                } else {
                    delete room.users[user]
                }
            }
        } else {
            ws.send(stringifyJSON(msg))
        }
    }
})

function parseJSON(str) {
    try { return JSON.parse(str) } catch (error) { }
}

function stringifyJSON(val, indent) {
    try { return JSON.stringify(val, (k, v) => k.slice(0, 1) == "_" ? undefined : v, indent) } catch (error) { }
}

let _idHash = "Vau1giFtLn_vsv12gQXe6Mn7rgvJ4NnEJ122JxpDfvE"
function newId() {
    let hash = crypto.createHash("md5")
    hash.update(_idHash + "?" + Date.now() + "&" + Math.random())
    return _idHash = hash.digest("base64").replaceAll("=", "")
}

function dehash(user, hash) {
    let keys = process.env.CHAT_KEYS?.split(/\s+/)
    if (!keys) return "debug"
    for (let key of keys) {
        let hasher = crypto.createHash("sha256")
        hasher.update(user.id + "&" + key)
        if (hasher.digest("hex").toLowerCase() == hash.toLowerCase()) return key
    }
    setTimeout(() => {
        user._ws.close(1008, "you know what you did")
    }, 1024 * 64)
    return "freeloader"
}


setInterval(async () => {
    for (let ws of wss.clients) {
        if (ws?.readyState === WebSocket.OPEN) {
            return ws.send(stringifyJSON({ type: "feedme", url: `http://${hostname}/up.json?now=${Date.now()}` }))
        }
    }
}, 1000 * 60 * 14)

module.exports = wss