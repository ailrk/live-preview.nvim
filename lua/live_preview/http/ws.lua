------------------------------------------------------------
--- live_server/http/ws.lua
---
--- Websocket implementation.
------------------------------------------------------------
local http = require("live_preview.http")
local sha1 = require("live_preview.http.sha1")
local bit = require("bit")
local M = {}


local WEBSOCKET_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


-- Computes the WebSocket accept key from the client challenge key
---@type fun(key: string): string
local function compute_ws_accept(key)
    local sha1_hex = sha1.sha1(key .. WEBSOCKET_MAGIC)
    -- Convert hex string back to binary representation
    local binary = ""
    for i = 1, #sha1_hex, 2 do
        local byte = tonumber(sha1_hex:sub(i, i+1), 16)
        binary = binary .. string.char(byte)
    end
    return vim.base64.encode(binary)
end


--- Frames a text payload string into a WebSocket text frame (unmasked)
--- @type fun(payload: string): string
local function frame_text(payload)
    local len = #payload
    local header = string.char(0x81) -- Fin bit set + Opcode 1 (Text)

    if len <= 125 then
        header = header .. string.char(len)
    elseif len <= 65535 then
        header = header .. string.char(126)
        -- Write 16-bit length (big-endian)
        header = header .. string.char(bit.band(bit.rshift(len, 8), 0xFF))
        header = header .. string.char(bit.band(len, 0xFF))
    else
        header = header .. string.char(127)
        -- Write 64-bit length (big-endian)
        -- Luajist bit library works on 32 bit signed integer, if we have
        -- message larger than 2^31 (2GB) this will overflow.
        -- In practice we probably never have any message larger than 2GB, but
        -- it's important to note here.
        for i = 7, 0, -1 do
            header = header .. string.char(bit.band(bit.rshift(len, i * 8), 0xFF))
        end
    end
    return header .. payload
end


-- Minimal parser to extract text frames sent from browser client
--- @type fun(chunk: string): string?
local function unframe_text(chunk)
    if #chunk < 2 then return nil end
    local byte2 = string.byte(chunk, 2)
    local is_masked = bit.band(byte2, 0x80) ~= 0
    local len = bit.band(byte2, 0x7F)

    local offset = 3
    if len == 126 then
        offset = 5
    elseif len == 127 then
        offset = 11
    end

    if not is_masked then return nil end -- Browser clients must always mask

    local mask = { string.byte(chunk, offset, offset + 3) }
    offset = offset + 4

    local payload = {}
    for i = 1, #chunk - offset + 1 do
        local byte = string.byte(chunk, offset + i - 1)
        local mask_byte = mask[(i - 1) % 4 + 1]
        table.insert(payload, string.char(bit.bxor(byte, mask_byte)))
    end
    return table.concat(payload)
end


--- Finish a websocket handshake and start the connection
---@type fun(inst: ServerInstance, sock: uv.uv_tcp_t, req_headers: table)
function M.accept(inst, sock, req_headers)
    -- Look for the client handshake challenge token
    local ws_key = req_headers["sec-websocket-key"]
    if not ws_key then
        local body = "Missing Sec-WebSocket-Key"
        http.write_headers(sock, 400, { ["content-length"] = tostring(#body) })
        sock:write(body)
        pcall(function() sock:close() end)
        return
    end

    local accept_key = compute_ws_accept(ws_key)
    local h = {
        ["upgrade"] = "websocket",
        ["connection"] = "Upgrade",
        ["sec-websocket-accept"] = accept_key,
    }

    -- Pass through CORS if configured explicitly
    local cors = inst.headers["access-control-allow-origin"]
    if cors then
        h["access-control-allow-origin"] = cors
    end

    -- Switch protocols to WebSocket
    http.write_headers(sock, 101, h)
    pcall(function() sock:nodelay(true) end) -- disable Nagle
    table.insert(inst.clients, sock)

    -- Start listening for ws message.
    sock:read_start(function(err, chunk)
        -- Connection teardown cleanup loop
        if err or not chunk then
            for i, cl in ipairs(inst.clients) do
                if cl == sock then
                    table.remove(inst.clients, i)
                    break
                end
            end
            pcall(function() sock:close() end)
            return
        end

        -- Parse incoming events from the browser (e.g., clicks)
        local raw_msg = unframe_text(chunk)
        if raw_msg and inst.on_message then
            pcall(inst.on_message, raw_msg)
        end
    end)
end



--- Teardown a client
--- @type fun(inst: ServerInstance, sock: uv.uv_tcp_t)
local function teardown(inst, sock)
    for i, cl in ipairs(inst.clients) do
        if cl == sock then
            table.remove(inst.clients, i)
            break
        end
    end
    pcall(function() sock:close() end)
end


--- Send a message to a websocket client
--- @type fun(inst: ServerInstance, sock: uv.uv_tcp_t, msg: table)
function M.send(inst, sock, data)
    local json_payload = vim.json.encode(data)
    local frame = frame_text(json_payload)
    sock:write(frame, function(err) if err then teardown(inst, sock) end end)
end


--- Broadcast message to all clients
--- @type fun(inst: ServerInstance, data: table)
function M.broadcast(inst, data)
    for i = 1, #inst.clients do
        M.send(inst, inst.clients[i], data)
    end
end

return M
