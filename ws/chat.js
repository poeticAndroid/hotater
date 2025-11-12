const WS = require("ws")
const crypto = require("crypto")
const fs = require("fs")

const wss = new WS.WebSocketServer({ noServer: true })

const topics = {}
const stats = {
    serverStartTime: Date.now(),
    updateTime: { hr: -1, min: -1, sec: -1 },
    _in: 0, _out: 0, _users: 0,
    in: { hr: [], min: [], sec: [] },
    out: { hr: [], min: [], sec: [] },
    users: { hr: [], min: [], sec: [] },
}

let hostname = "localhost"

wss.on('connection', (ws, req) => {
    hostname = req?.headers?.host || hostname

    let user, topic, room

    ws.on('error', console.error)

    ws.on('message', (msg) => {
        stats._in += msg.length
        if (msg.length > 1024 * 64) return ws.close(1009, "too much!")
        // console.log('message: %s', msg)
        if (!(msg = parseJSON(msg))) return ws.close(1007, "bad json")

        switch (msg.type) {
            case "ping":
                msg.server_time = Date.now()
                send(msg, user?.id)
                break;

            case "user":
                if (user) return ws.close(1002, "already user")
                if (!msg.name) return ws.close(1002, "bad user")
                if (typeof msg.name != "string") return ws.close(1002, "bad user")

                user = {
                    type: "user",
                    id: newId(),
                    _origin: req?.headers?.origin || req?.headers?.referer || "",
                    name: msg.name,
                    meta: msg.meta,
                    _ws: ws
                }
                if (user._origin && user._origin.slice(-1) != "/") user._origin += "/"
                console.log(user.name, "connected from", user._origin)
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
                    user_count: 0,
                    rooms: {}
                }
                topic = topics[topic._key] = topics[topic._key] || topic

                topic.user_count = 0
                for (let id in topic.rooms) {
                    let room = topic.rooms[id]
                    let count = 0
                    for (let user in room.users) {
                        if (room.users[user]?._ws?.readyState === WS.WebSocket.OPEN) count++
                        else delete room.users[user]
                    }
                    topic.user_count += count
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
                    if (room.host != user.id) return ws.close(1008, "unauthorized")

                    if (msg.meta !== undefined) room.meta = msg.meta
                    if (msg.password !== undefined) room._password = msg.password
                    if (msg.open !== undefined) room.open = msg.open

                    if (room.open) topic.rooms[room.id] = room
                    else delete topic.rooms[room.id]
                } else if (msg.id) {
                    room = topic.rooms[msg.id]
                    if (!room?.open) return ws.close(1002, "bad room")
                    if (room?._password != msg.password) return ws.close(1002, "bad room")
                    if (room._objPath) processObj(room, user)
                    topic.user_count++
                    console.log(user.name, "joined room", room.name)
                } else if (msg.name) {
                    room = {
                        type: "room", id: newId(), name: "" + msg.name, meta: msg.meta, host: user.id,
                        open: true, private: !!(msg.password), _password: msg.password, users: {}
                    }
                    topic.rooms[room.id] = room
                    topic.user_count++
                    console.log(user.name, "created room", room.name)
                } else {
                    return ws.close(1002, "bad room")
                }
                room.users[user.id] = user

                send(room)
                clearTimeout(patience)
                break;

            case "obj":
                msg.id = msg.id || newId()
            case "msg":
                if (!room) return ws.close(1002, "no room")

                msg.from = user.id
                send(msg, msg.to || "all")
                break;

            case "kick":
                if (!room) return ws.close(1002, "no room")
                if (room.host != user.id) return ws.close(1008, "unauthorized")

                if (room.users[msg.id]?._ws?.readyState === WS.WebSocket.OPEN) room.users[msg.id]._ws.close(1008, "kicked")
                delete room.users[msg.id]
                break;

            default:
                return ws.close(1002, "bad type")
                break;
        }
    })

    ws.on('close', (code, reason) => {
        if (room) {
            topic.user_count--
            stats._out += reason.length
            console.log(user.name, "left room", room.name, "because", code, "" + reason)
            delete room.users[user.id]
            if (room.host == user.id) {
                room.host = null
                for (let id in room.users) {
                    if (Math.random() || !room.host) room.host = id
                }
            }
            send(room)
        }
    })

    function send(msg, recipient = "all") {
        let jsn = stringifyJSON(msg)
        if (room) {
            switch (recipient) {
                case "all":
                case "everyone":
                    for (let user in room.users) {
                        if (room.users[user]?._ws?.readyState === WS.WebSocket.OPEN) {
                            stats._out += jsn.length
                            room.users[user]._ws.send(jsn)
                        } else {
                            delete room.users[user]
                        }
                    }
                    break;

                case "other":
                case "others":
                    for (let user in room.users) {
                        if (room.users[user]?._ws?.readyState === WS.WebSocket.OPEN) {
                            if (user != msg.from) {
                                stats._out += jsn.length
                                room.users[user]._ws.send(jsn)
                            }
                        } else {
                            delete room.users[user]
                        }
                    }
                    break;

                case "host":
                case "admin":
                    recipient = room.host
                default:
                    if (room.users[recipient]?._ws?.readyState === WS.WebSocket.OPEN) {
                        stats._out += jsn.length
                        room.users[recipient]._ws.send(jsn)
                    }
                    break;
            }
        } else {
            stats._out += jsn.length
            ws.send(jsn)
        }
    }

    let patience = setTimeout(() => { ws.close(1008, "timeout") }, 4096)
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
    return _idHash = hash.digest("base64url").replaceAll("=", "").replaceAll("_", "").replaceAll("-", "")
}

function dehash(user, hash) {
    let keys = process.env.CHAT_KEYS?.split(/\s+/)
    if (!keys) return "debug"
    for (let key of keys) {
        if (user._origin != key.slice(0, user._origin?.length)) continue
        let hasher = crypto.createHash("sha256")
        hasher.update(user.id + "@" + key)
        if (hasher.digest("hex").toLowerCase() == hash.toLowerCase()) return key
    }
    console.log(user.name, "is a freeloader!")
    setTimeout(() => {
        user._ws.close(1008, "you know what you did")
    }, 1024 * 64)
    return "freeloader"
}


setInterval(async () => {
    let msg = stringifyJSON({ type: "feedme", url: `http://${hostname}/up.json?now=${Date.now()}` })
    for (let ws of wss.clients) {
        if (ws?.readyState === WS.WebSocket.OPEN) {
            stats._out += msg.length
            return ws.send(msg)
        }
    }
}, 1000 * 60 * 14)

let lastStats
function updateStats() {
    let now = new Date()
    setTimeout(updateStats, 1000 - now.getMilliseconds())

    stats._users = 0
    for (let key in topics) {
        stats._users += topics[key].user_count
    }

    if (stats.updateTime.sec != now.getSeconds()) {
        stats.updateTime.sec = now.getSeconds()
        stats.in.sec[stats.updateTime.sec] = 0
        stats.out.sec[stats.updateTime.sec] = 0
        stats.users.sec[stats.updateTime.sec] = 0
        if (stats.updateTime.min != now.getMinutes()) {
            stats.updateTime.min = now.getMinutes()
            stats.in.min[stats.updateTime.min] = 0
            stats.out.min[stats.updateTime.min] = 0
            stats.users.min[stats.updateTime.min] = 0
            if (stats.updateTime.hr != now.getHours()) {
                stats.updateTime.hr = now.getHours()
                stats.in.hr[stats.updateTime.hr] = 0
                stats.out.hr[stats.updateTime.hr] = 0
                stats.users.hr[stats.updateTime.hr] = 0
            }
        }
    }


    stats.in.sec[stats.updateTime.sec] += stats._in
    stats.out.sec[stats.updateTime.sec] += stats._out
    stats.users.sec[stats.updateTime.sec] = stats._users

    stats.in.min[stats.updateTime.min] += stats._in
    stats.out.min[stats.updateTime.min] += stats._out
    stats.users.min[stats.updateTime.min] = stats._users

    stats.in.hr[stats.updateTime.hr] += stats._in
    stats.out.hr[stats.updateTime.hr] += stats._out
    stats.users.hr[stats.updateTime.hr] = stats._users

    stats._in = 0
    stats._out = 0
    stats._users = 0


    // let jsn = stringifyJSON(stats)
    // if (lastStats != jsn) {
    //     lastStats = jsn
    //     fs.writeFile("chat_stats.json", jsn, err => null)
    // }
}
setTimeout(updateStats, 1024)

wss.stats = stats
module.exports = wss