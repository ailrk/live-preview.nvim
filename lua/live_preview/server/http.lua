------------------------------------------------------------
--- live_server/http.lua
---
--- A very simple http library.
---
--- `write_headers` simply streaming the header through tcp socket.
--- `send_response` construct a complete http response
--- `parse_request` parse a http request into a table
---
--- All headers are converted into lower case.
------------------------------------------------------------

local util = require("live_preview.server.util")

local M = {}

---@type fun(sock: uv.uv_tcp_t, status: integer, headers?: table<string, string>)
function M.write_headers(sock, status, headers)
    local reason = ({
        [200] = "OK",
        [301] = "Moved Permanently",
        [302] = "Found",
        [400] = "Bad Request",
        [404] = "Not Found",
        [405] = "Method Not Allowed",
        [500] = "Internal Server Error"
    })[status] or "OK"
    local lines = { ("HTTP/1.1 %d %s\r\n"):format(status, reason) }
    for k, v in pairs(headers or {}) do
        table.insert(lines, ("%s: %s\r\n"):format(k, v))
    end
    table.insert(lines, "\r\n")
    sock:write(table.concat(lines))
end


---@type fun(sock: uv.uv_tcp_t, status: integer, headers?: table<string, string|number>, body?: string)
function M.send_response(sock, status, headers, body)
    local h = headers or {}
    if body then h["content-length"] = #body end
    h["connection"] = "close"
    M.write_headers(sock, status, h)
    if body then sock:write(body) end
    sock:shutdown(function() sock:close() end)
end


---@type fun(status: integer, title: string, detail: string): string
function M.error_page(status, title, detail)
    return string.format(
        '<!doctype html><html><head><meta charset="utf-8"><title>%d %s</title>'
        .. '<style>:root{color-scheme:light dark}'
        .. 'body{font:16px/1.6 system-ui,sans-serif;padding:40px;max-width:600px;margin:80px auto;text-align:center}'
        .. 'h1{font-size:48px;margin:0;opacity:.3}p{opacity:.7}'
        .. 'code{background:rgba(127,127,127,.15);padding:2px 8px;border-radius:4px;font-size:14px}'
        .. '</style></head><body><h1>%d</h1><p>%s</p><p><code>%s</code></p></body></html>',
        status, util.html_escape(title), status, util.html_escape(title), util.html_escape(detail))
    end


---@type fun(sock: uv.uv_tcp_t, path: string)
function M.http_404(sock, path)
    M.send_response(sock, 404, { ["content-type"] = "text/html; charset=utf-8" }, M.error_page(404, "Not Found", path))
end


---@type fun(sock: uv.uv_tcp_t, msg?: string)
function M.http_400(sock, msg)
    M.send_response(sock, 400, { ["content-type"] = "text/html; charset=utf-8" }, M.error_page(400, "Bad Request", msg or ""))
end


--- A typical HTTP header format
--- [Method] [Request-URI] [HTTP-Version] \r\n
--- [Header-Name]: [Header-Value] \r\n
--- ...
--- \r\n
--- [Optional Message Body]
---
--- All headers are conerted to lower case.
---@type fun(buf: string): { method: string, path: string, headers: table<string, string>, body: string }?
function M.parse_request(buf)
    -- Parse the request line
    local line = buf:match("([^\r\n]+)")
    if not line then return nil end

    -- Parse the path line
    local m, path = line:match("^(%u+)%s+([^%s]+)")
    if not m or not path then return nil end

    local request = {
        method = m,
        path = path,
        headers = {},
        body = ""
    }

    -- Loop through the remaining headers
    local header_end = buf:find("\r?\n\r?\n")
    local header_section = buf

    if header_end then
        header_section = buf:sub(1, header_end)
        request.body = buf:sub(header_end + 4) -- Step past the \r\n\r\n
    end

    for line in header_section:gmatch("([^\r\n]+)") do
        -- HTTP headers end at the first empty line
        if line == "" then break end

        -- Headers are formatted as "Key: Value"
        local key, value = line:match("^([^:]+):%s*(.*)$")
        if key and value then
            -- Lowercase the key to make lookups easier (standard practice)
            request.headers[key:lower()] = value
        end
    end

    return request
end

return M
