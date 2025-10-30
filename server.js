const http = require("http"),
    fs = require("fs"),
    path = require("path")

const WSServers = {}

const hostname = "0.0.0.0"
const port = process.env.PORT || 9001
const server = http.createServer()

server.on("upgrade", (req, socket, head) => {
    if (req.url.slice(0, 4) == "/ws/") {
        let api = req.url.split("/").pop()
        if (!WSServers[api]) {
            try {
                WSServers[api] = require("./ws/" + api + ".js")
            } catch (error) {
                console.error("Could not start server api", api, error)
                WSServers[api] = null
                socket.destroy()
                return;
            }
        }
        let wss = WSServers[api]
        wss.handleUpgrade(req, socket, head, function done(ws) {
            wss.emit('connection', ws, req)
        })
    } else {
        socket.destroy()
    }
})

server.on("request", (req, res) => {
    res.setHeader("Cache-Control", "max-age=4096")
    let filename = "." + req.url
    for (let char of "?&#;")
        if (filename.includes(char)) filename = filename.slice(0, filename.indexOf(char))
    if (filename.slice(-1) === "/") {
        filename += "index.html"
    }
    if (filename.slice(0, 3) === "./.") {
        res.statusCode = 404
        res.setHeader("Content-Type", "text/html; charset=utf-8")
        res.end("<h1> nope ")
        return
    }
    let ext = filename.slice(filename.lastIndexOf("."))
    switch (ext) {
        case ".html":
            res.setHeader("Content-Type", "text/html; charset=utf-8")
            break
        case ".css":
            res.setHeader("Content-Type", "text/css; charset=utf-8")
            break
        case ".js":
            res.setHeader("Content-Type", "application/javascript; charset=utf-8")
            break
        default:
            res.setHeader("Content-Type", "text/plain; charset=utf-8")
    }
    console.log(req.method, req.url, "->", filename)
    fs.readFile(filename, (err, data) => {
        if (err) {
            res.statusCode = 404
            res.setHeader("Content-Type", "text/html; charset=utf-8")
            res.end("<h1>nothing here")
        } else {
            res.statusCode = 200
            res.end(data)
        }
    })
})

server.listen(port, hostname, () => {
    console.log(`Server running at http://${hostname}:${port}/`)
})