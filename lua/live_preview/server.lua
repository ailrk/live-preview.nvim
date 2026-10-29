local uv   = vim.loop
local util = require("live_preview.http.util")
local http = require("live_preview.http")
local ws = require("live_preview.http.ws")
local file = require("live_preview.file")
local S = {}

---@class ServerInstance
---@field handle uv.uv_tcp_t
---@field host string
---@field port number
---@field roots string[]
---@field headers table<string, string>
---@field started_at integer
---@field live_debounce integer
---@field clients uv.uv_tcp_t[]
---@field on_message fun()
---@field index_names string[]
---@field token string?
---@field protected_paths string[]
---@field asset_root string|fun():string?|nil
---@field cdn_map fun(p: string, ...)[]
---@field cdn_root string
---@field extra_asset_roots string[]
---@field fs_event uv.uv_fs_event_t?
---@field _fs_events table<string, uv.uv_fs_event_t>?

-- Capability flags for callers to feature-detect against an independently
-- versioned install (plugin managers update sibling plugins separately).
S.features = {
    token_auth = true,
    host_binding = true,
    asset_route = true,
}

-- MIME type strings
local MIME = {
    html = "text/html; charset=utf-8",
    htm = "text/html; charset=utf-8",
    css = "text/css; charset=utf-8",
    js = "application/javascript; charset=utf-8",
    mjs = "application/javascript; charset=utf-8",
    json = "application/json; charset=utf-8",
    txt = "text/plain; charset=utf-8",
    svg = "image/svg+xml",
    png = "image/png",
    jpg = "image/jpeg",
    jpeg = "image/jpeg",
    gif = "image/gif",
    ico = "image/x-icon",
    wasm = "application/wasm",
}

---@type fun(path: string): string
local function guess_mime(path)
    local ext = string.match(path, "%.([%w]+)$")
    return (ext and MIME[ext:lower()]) or "application/octet-stream"
end

------------------------------------------------------------
-- Path mapping & file read
------------------------------------------------------------

-- Canonicalize a request path so the auth gate and the file mapper can never
-- disagree. The following steps is performed:
--
-- 1. Strip the query, percent-decode
-- 2. then lexically resolve '.'/'..'
-- 3. collapse duplicate slashes.
--
-- Without this a peer could evade a protected_paths pattern with an encoded
-- or slash-padded variant that still resolves to the protected file:
-- //content.md, /content%2emd, /x/../content.md.
---@type fun(req_path: string): string
local function normalize_path(req_path)
    local raw = req_path:match("^([^?#]*)") or req_path
    raw = util.url_decode(raw)
    local parts = {}
    for seg in raw:gmatch("[^/]+") do
        if seg == ".." then
            parts[#parts] = nil
        elseif seg ~= "." then
            parts[#parts + 1] = seg
        end
    end
    return "/" .. table.concat(parts, "/")
end

-- Map an already-normalized path (see normalize_path) to a real file under
-- root. realpath containment stays as defense in depth against anything
-- normalization missed (symlinks, filesystem-level surprises).
---@type fun(norm_path: string, root_real: string): string?
local function sanitize_and_map(norm_path, root_real)
    if norm_path == "/" then
        return root_real
    end
    local joined = util.joinpath(root_real, (norm_path:gsub("^/+", "")))
    local real = uv.fs_realpath(joined)
    if not real then return nil end
    if not util.path_has_prefix(real, root_real) then return nil end
    return real
end

---@type fun(abs_path: string): string?, uv.fs_stat.result?
local function read_file_all(abs_path)
    local fd = uv.fs_open(abs_path, "r", 438)
    if not fd then return nil end
    local stat = uv.fs_fstat(fd)
    if not stat or stat.type ~= "file" then
        uv.fs_close(fd)
        return nil
    end
    local chunk = uv.fs_read(fd, stat.size, 0)
    uv.fs_close(fd)
    return chunk, stat
end

------------------------------------------------------------
-- HTML helpers (templating)
------------------------------------------------------------

local function send_html(sock, html, extra_headers)
    local headers = { ["Content-Type"] = "text/html; charset=utf-8" }
    for k, v in pairs(extra_headers or {}) do headers[k] = v end
    http.send_response(sock, 200, headers, html)
end

local function serve_html_file(sock, abs_path, extra_headers)
    local body = read_file_all(abs_path)
    if not body then return http.http_404(sock, abs_path) end
    send_html(sock, body, extra_headers)
end

------------------------------------------------------------
-- Static file streaming
------------------------------------------------------------

local function stream_file(sock, abs_path, extra_headers)
    local fd = uv.fs_open(abs_path, "r", 438)
    if not fd then return http.http_404(sock, abs_path) end
    local stat = uv.fs_fstat(fd)
    if not stat or stat.type ~= "file" then
        uv.fs_close(fd)
        return http.http_404(sock, abs_path)
    end

    local headers = { ["Content-Type"] = guess_mime(abs_path), ["Content-Length"] = stat.size, ["Connection"] = "close" }
    for k, v in pairs(extra_headers or {}) do headers[k] = v end
    http.write_headers(sock, 200, headers)

    local offset = 0
    local function read_chunk()
        uv.fs_read(fd, 64 * 1024, offset, function(err_read, data)
            if err_read or not data then
                uv.fs_close(fd)
                sock:shutdown(function() sock:close() end)
                return
            end
            offset = offset + #data
            sock:write(data, function()
                if #data < 64 * 1024 then
                    uv.fs_close(fd)
                    sock:shutdown(function() sock:close() end)
                else
                    read_chunk()
                end
            end)
        end)
    end
    read_chunk()
end

local function serve_path(sock, abs_path, req_path, extra_headers)
    local mime = guess_mime(abs_path)
    if mime:find("^text/html") then
        return serve_html_file(sock, abs_path, extra_headers)
    else
        return stream_file(sock, abs_path, extra_headers)
    end
end

------------------------------------------------------------
-- Server
------------------------------------------------------------

---@type fun(inst: ServerInstance, sock: uv.uv_tcp_t): fun()
local function on_request(inst, sock)
    return function(err_read, chunk)
        ----------------------------------------
        --- guarding
        ----------------------------------------

        if err_read then
            sock:close()
            return
        end

        if not chunk then
            sock:close()
            return
        end

        local req = http.parse_request(chunk)
        if not req then return http.http_400(sock, "Cannot parse request") end
        if req.method ~= "GET" then
            return http.send_response(sock, 405, { ["content-type"] = "text/plain" }, "Method Not Allowed")
        end

        ----------------------------------------
        -- token endpoint
        ----------------------------------------

        -- Canonicalize the path once; auth matching, endpoint dispatch,
        -- and file mapping all use this same string so an encoded or
        -- slash-padded variant can't reach a protected file ungated.
        local path_only = normalize_path(req.path)
        local query     = req.path:match("%?(.*)$") or ""

        -- Pull a query-string parameter by key. Anchored to either
        -- the start of the query or just after an '&' so we don't
        -- accidentally match a key as a substring of another (e.g.
        -- 't' inside 'event').
        local function qparam(key)
            return query:match("^" .. key .. "=([^&]*)")
            or query:match("&" .. key .. "=([^&]*)")
        end

        -- Auth gate. When inst.token is set, the SSE stream, the event
        -- injection endpoint, and any path in inst.protected_paths
        -- require a matching ?t=<token>. Static assets (/index.html,
        -- /style.css, /favicon.ico, etc.) are intentionally NOT gated
        -- because the browser bootstraps from them before any JS runs
        -- and cannot append query strings to <link>/<img> tags it
        -- discovers itself. Protect the user content (caller passes
        -- protected_paths) and the live-reload control plane.
        if inst.token then
            local function path_needs_auth(p)
                if p == "/__live/ws" or p == "/__live/asset" then
                    return true
                end
                for _, pat in ipairs(inst.protected_paths) do
                    if p:find(pat) then return true end
                end
                return false
            end
            if path_needs_auth(path_only) then
                local req_token = qparam("t")
                local decoded = req_token and util.url_decode(req_token) or ""
                if not util.secure_compare(decoded, inst.token) then
                    return http.send_response(sock, 401,
                    { ["content-type"] = "text/plain" }, "Unauthorized")
                end
            end
        end

        ------------------------------
        -- Websocket
        ------------------------------

        if path_only == "/__live/ws" then
            ws.accept(inst, sock, req.headers)
            return
        end

        ------------------------------
        -- Asset
        ------------------------------

        if path_only == "/__live/asset" then
            local aroot = inst.asset_root
            if type(aroot) == "function" then
                local ok_root, res = pcall(aroot)
                aroot = ok_root and res or nil
            end
            local rel = qparam("p")
            rel = rel and util.url_decode(rel) or ""
            -- Relative paths only: reject absolute paths, drive
            -- letters / URL schemes (':'), and backslashes outright;
            -- realpath containment below handles '..' traversal.
            -- extra_asset_roots will be permitted.
            if not aroot or rel == "" or rel:find("^/") or rel:find(":") or rel:find("\\") then
                return http.http_404(sock, "/__live/asset")
            end
            local aroot_real = uv.fs_realpath(aroot)
            local allowed = { aroot_real }

            for _, extra in ipairs(inst.extra_asset_roots or {}) do
                local r = uv.fs_realpath(extra)
                if r then table.insert(allowed, r) end
            end

            local function under_allowed(p)
                for _, root in ipairs(allowed) do
                    if util.path_has_prefix(p, root) then return true end
                end
                return false
            end

            if not aroot_real then return http.http_404(sock, "/__live/asset") end
            local ok_real, real = pcall(uv.fs_realpath, util.joinpath(aroot_real, rel))

            if not ok_real or not real or not under_allowed(real) then
                return http.http_404(sock, "/__live/asset")
            end

            return stream_file(sock, real, inst.headers)
        end

        ------------------------------
        -- CDN
        ------------------------------

        if path_only:find("^/__live/cdn") then
            local croot = inst.cdn_root
            if not croot then
                return http.http_404(sock, path_only)
            end

            local sub_path = path_only:match("^/__live/cdn/(.+)")
            if not sub_path then
                return http.http_404(sock, path_only)
            end

            local segments = {}
            for seg in sub_path:gmatch("[^/]+") do
                table.insert(segments, util.url_decode(seg))
            end

            if #segments == 0 then
                return http.http_404(sock, path_only)
            end

            local p = segments[1]
            local extra_params = {}
            for i = 2, #segments do
                table.insert(extra_params, segments[i])
            end

            -- Resolve CDN URL via the instance's cdn_map function
            local cdn_url = inst.cdn_map(p, unpack(extra_params))

            if not cdn_url then
                return http.http_404(sock, path_only)
            end

            -- Create local look-aside cache path structure based on sub_path
            local cached_file_path = util.joinpath(croot, sub_path)

            -- Check if it's already cached on disk
            local stat = uv.fs_stat(cached_file_path)
            if stat and stat.type == "file" then
                return stream_file(sock, cached_file_path, inst.headers)
            end

            -- If not cached, fetch it and save it to cached_file_path before
            -- streaming.
            http.fetch(cdn_url, function(err, body)
                if err or not body then
                    return vim.schedule(function()
                        http.http_404(sock, path_only)
                    end)
                end
                vim.schedule(function()
                    local ok, werr = pcall(file.write_text, cached_file_path, body)
                    if not ok then
                        vim.notify("live_preview: CDN cache write failed: " .. tostring(werr), vim.log.levels.WARN)
                        -- Still serve the body even if caching failed
                        return http.send_response(sock, 200, {
                            ["Content-Type"] = guess_mime(cached_file_path),
                        }, body)
                    end
                    stream_file(sock, cached_file_path, inst.headers)
                end)
            end)
            return -- fetch takes over the continuation
        end

        ------------------------------
        -- Serving
        ------------------------------

        -- Map path. Will search roots in the order of cfg.roots
        local mapped = nil
        local st = nil
        for _, root in ipairs(inst.roots) do
            local root_real = uv.fs_realpath(root)
            if not root_real then error("Invalid root: " .. tostring(root)) end
            mapped = sanitize_and_map(path_only, root_real)
            vim.print("live_preview/server.lua:379 on_request: ", { path_only})  -- @print
            vim.print("live_preview/server.lua:379 on_request: ", { path_only})  -- @print
            if mapped then
                st = uv.fs_stat(mapped)
                if st and st.type == "directory" then
                    local candidate
                    for _, iname in ipairs(inst.index_names) do
                        local try = util.joinpath(mapped, iname)
                        if uv.fs_stat(try) then candidate = try; break end
                    end
                    if candidate and uv.fs_stat(candidate) then
                        return serve_path(sock, candidate, req.path, inst.headers)
                    else
                        goto continue
                    end
                elseif st and st.type == "file" then
                    return serve_path(sock, mapped, req.path, inst.headers)
                else
                    goto continue
                end
            end
            ::continue::
        end

        -- catch all
        return http.http_404(sock, req.path)
    end
end

---@type fun(inst: ServerInstance, tcp: uv.uv_tcp_t)
local function start_server(inst, tcp)
    tcp:listen(128, function(err_listen)
        if err_listen then return end

        local sock = uv.new_tcp()
        if sock == nil then
            error("failed to create new tcp socket")
        end

        tcp:accept(sock)
        sock:read_start(on_request(inst, sock))
    end)
end

------------------------------------------------------------
-- Server API
------------------------------------------------------------

function S.start(cfg)
    local tcp = uv.new_tcp()
    if tcp == nil then
        error("failed to create a new tcp socket")
    end

    local host = cfg.host or "127.0.0.1"
    local port = 0

    local ok, bind_err = pcall(function() tcp:bind(host, port) end)
    if not ok then error(bind_err or "bind failed") end

    -- Resolve actual port (pass in port as 0, get the OS-assigned port)
    local actual_port = cfg.port
    actual_port = tcp:getsockname().port

    local headers = vim.tbl_extend("keep", cfg.headers or {}, {})
    if cfg.cors then
        headers["access-control-allow-origin"] = type(cfg.cors) == "string" and cfg.cors or "*"
    end

    ---@type ServerInstance
    local inst = {
        handle            = tcp,
        port              = actual_port,
        host              = host,
        roots             = cfg.roots,
        headers           = headers,
        started_at        = os.time(),

        -- live
        live_debounce     = (cfg.live and cfg.live.debounce) or 120,
        clients           = {},
        on_message        = cfg.on_message,

        -- features
        index_names       = cfg.index_names or { "index.html", "index.htm" },

        -- auth
        token             = cfg.token, -- nil = no auth; string = required on protected paths
        protected_paths   = cfg.protected_paths or {},

        -- /__live/asset root: a directory, or a function returning one.
        -- Lets a caller expose files that live next to its source document
        -- (e.g. images referenced from markdown) without serving that
        -- directory as the root. Token-gated whenever token is set.
        asset_root        = cfg.asset_root,
        extra_asset_roots = cfg.extra_asset_roots,

        cdn_map           = cfg.cdn_map,
        cdn_root          = cfg.cdn_root
    }

    local ok, bind_err = pcall(start_server, inst, tcp)
    if not ok then error(bind_err or "listen failed") end

    return inst
end

function S.stop(inst)
    for _, cl in ipairs(inst.clients) do pcall(function() cl:close() end) end
    inst.clients = {}
    pcall(function() inst.handle:close() end)
end

function S.update_target(inst, new_roots)
    inst.roots = new_roots
end

-- Live-reload controls
---@type fun(inst: ServerInstance, reason_path: string, tick: integer)
function S.reload(inst, reason_path, tick)
    local rp = tostring(reason_path or "")
    ws.broadcast(inst, {
        type = "reload",
        ts = (":%d"):format(os.time()),
        path = rp,
        tick = tick,
    })
end

function S.connected_client_count(inst) return #inst.clients end

return S
