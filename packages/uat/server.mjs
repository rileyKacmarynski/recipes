import { createServer, request } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

export async function serveFrontend(directory, apiOrigin, log) {
  const root = resolve(directory)
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  }
  const server = createServer(async (req, res) => {
    log(`${req.method} ${req.url}\n`)
    if (req.url.startsWith('/api/')) {
      const upstream = request(
        new URL(apiOrigin),
        {
          path: req.url.slice(4),
          method: req.method,
          headers: { ...req.headers, host: new URL(apiOrigin).host },
        },
        (response) => {
          res.writeHead(response.statusCode, response.headers)
          response.pipe(res)
        },
      )
      upstream.on('error', (error) => {
        log(`${error.stack}\n`)
        res.writeHead(502).end('API unavailable')
      })
      req.pipe(upstream)
      return
    }
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
      const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
      if (!path.startsWith(root + sep)) {
        res.writeHead(403).end()
        return
      }
      let content
      let extension = extname(path)
      try {
        content = await readFile(path)
      } catch {
        if (extension) {
          res.writeHead(404).end()
          return
        }
        content = await readFile(resolve(root, 'index.html'))
        extension = '.html'
      }
      res.writeHead(200, {
        'content-type': types[extension] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      })
      res.end(content)
    } catch (error) {
      log(`${error.stack}\n`)
      res.writeHead(500).end()
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    stop: async () => {
      server.closeAllConnections()
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
