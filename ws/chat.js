const ws = require("ws")
const crypto = require("crypto")
const fs = require("fs")

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
                    if (room.host != user.id) return ws.close(1008, "unauthorized")

                    if (msg.meta !== undefined) room.meta = msg.meta
                    if (msg.store_obj !== undefined) room.store_obj = Math.min(Math.abs(+msg.store_obj || 0), 2)
                    if (msg.password !== undefined) room._password = msg.password
                    if (msg.open !== undefined) room.open = msg.open

                    if (room.open) topic.rooms[room.id] = room
                    else delete topic.rooms[room.id]
                } else if (msg.id) {
                    room = topic.rooms[msg.id]
                    if (!room?.open) return ws.close(1002, "bad room")
                    if (room?._password != msg.password) return ws.close(1002, "bad room")
                    if (room._objPath) processObj(room, user)
                    console.log(user.name, "joined room", room.name)
                } else if (msg.name) {
                    room = {
                        type: "room", id: newId(), name: "" + msg.name, meta: msg.meta, host: user.id,
                        open: true, private: !!(msg.password), _password: msg.password,
                        store_obj: Math.min(Math.abs(+msg.store_obj || 0), 2),
                        _nextObjId: 1, users: {}
                    }
                    topic.rooms[room.id] = room
                    console.log(user.name, "created room", room.name)
                } else {
                    return ws.close(1002, "bad room")
                }
                room.users[user.id] = user

                if (room.store_obj && !room._objPath) {
                    room._objPath = `_chat_obj/${topic._key}/${room.id}`
                    fs.mkdirSync(room._objPath, { recursive: true })
                }

                send(room)
                break;

            case "msg":
                if (!room) return ws.close(1002, "no room")
                if (!msg.to) return ws.close(1002, "bad to")

                msg.from = user.id
                send(msg, msg.to || "all")
                break;


            case "obj":
                if (!room) return ws.close(1002, "no room")

                msg.from = user.id
                if (room.store_obj) {
                    if (room.store_obj > 1 || room.host == user.id) {
                        processObj(room, msg)
                    }
                }

                send(msg, (room.store_obj == 1 && room.host != user.id) ? room.host : "all")
                break;


            case "kick":
                if (!room) return ws.close(1002, "no room")
                if (room.host != user.id) return ws.close(1008, "unauthorized")

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
                        if (room.users[user]?._ws?.readyState === WebSocket.OPEN) {
                            room.users[user]._ws.send(jsn)
                        } else {
                            delete room.users[user]
                        }
                    }
                    break;

                case "other":
                case "others":
                    for (let user in room.users) {
                        if (room.users[user]?._ws?.readyState === WebSocket.OPEN) {
                            if (user != msg.from) room.users[user]._ws.send(jsn)
                        } else {
                            delete room.users[user]
                        }
                    }
                    break;

                default:
                    if (room.users[recipient]?._ws?.readyState === WebSocket.OPEN)
                        room.users[recipient]._ws.send(jsn)
                    break;
            }
        } else {
            ws.send(jsn)
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
    for (let ws of wss.clients) {
        if (ws?.readyState === WebSocket.OPEN) {
            return ws.send(stringifyJSON({ type: "feedme", url: `http://${hostname}/up.json?now=${Date.now()}` }))
        }
    }
}, 1000 * 60 * 14)

let objTaskQueue = []
let processingObj
function processObj(room, task) {
    if (task) objTaskQueue.push(arguments)
    if (processingObj) return;
    processingObj = !!(objTaskQueue.length)
    if (!processingObj) return;

    if (objTaskQueue[0]?.[1]?.type == "user") {
        let [room, user] = objTaskQueue.shift()
        let id = 1
        let sendObj = (err, data) => {
            if (user?._ws?.readyState === WebSocket.OPEN) {
                if (data) user._ws.send(data)
                if (id < room._nextObjId) {
                    fs.readFile(`${room._objPath}/obj_${id++}.json`, sendObj)
                } else {
                    processingObj = false
                    setTimeout(processObj)
                }
            }
        }
        sendObj()
    } else {
        let [room, obj] = objTaskQueue.shift()
        obj.id = +obj.id || room._nextObjId++
        let tmp_file = `${room._objPath}/obj_${Math.random()}.tmp`
        let obj_file = `${room._objPath}/obj_${obj.id}.json`
        if (obj.deleted) {
            fs.unlink(obj_file, nextObj)
        } else {
            fs.readFile(obj_file, (err, data) => {
                data = parseJSON(data) || {}
                for (let key in obj) {
                    data[key] = obj[key]
                }
                fs.writeFile(tmp_file, stringifyJSON(data), err => {
                    if (err) fs.unlink(tmp_file, nextObj)
                    else fs.rename(tmp_file, obj_file, nextObj)
                })
            })
        }
    }
}

function nextObj() {
    processingObj = false
    setTimeout(processObj)
}


module.exports = wss