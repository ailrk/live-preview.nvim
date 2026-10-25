local uv = vim.loop
local U = {}

function U.notify(msg, opts, level)
    if opts and opts.notify == false then return end
    vim.notify(msg, (level and vim.log.levels[level]) or vim.log.levels.INFO, { title = "live-server.nvim" })
end

function U.joinpath(...)
    local sep = package.config:sub(1, 1)
    return table.concat({ ... }, sep)
end

function U.dirname(p) return p:match("^(.*)[/\\]") or "." end

function U.basename(p) return (p:gsub("[/\\]+$", "")):match("([^/\\]+)$") or p end

function U.url_decode(s)
    s = s:gsub("+", " ")
    s = s:gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end)
    return s
end

function U.url_encode(s)
    return (tostring(s):gsub("([^%w%-%._~])", function(c) return string.format("%%%02X", string.byte(c)) end))
end

-- Generate a random hex token. Uses /dev/urandom when available, otherwise
-- falls back to math.random seeded from uv.hrtime + os.time + pid. The
-- fallback is not crypto-grade but raises the bar substantially over no auth,
-- which is the threat model for a LAN-bound dev server.
function U.random_token(byte_len)
    byte_len = byte_len or 16 -- 16 bytes = 32 hex chars = 128 bits
    local fd = uv.fs_open("/dev/urandom", "r", 384)
    if fd then
        local data = uv.fs_read(fd, byte_len, 0)
        uv.fs_close(fd)
        if data and #data == byte_len then
            local hex = {}
            for i = 1, #data do hex[i] = string.format("%02x", string.byte(data, i)) end
            return table.concat(hex)
        end
    end
    math.randomseed((uv.hrtime() % 2147483647) + os.time() + vim.fn.getpid())
    local hex = {}
    for i = 1, byte_len do hex[i] = string.format("%02x", math.random(0, 255)) end
    return table.concat(hex)
end

-- Constant-time-ish string comparison. Not strictly required at LAN-trust
-- scope (a 128-bit token is infeasible to brute-force regardless), but cheap
-- to do right and avoids handing attackers a trivial timing oracle.
function U.secure_compare(a, b)
    if type(a) ~= "string" or type(b) ~= "string" then return false end
    if #a ~= #b then return false end
    local mismatch = 0
    for i = 1, #a do
        if string.byte(a, i) ~= string.byte(b, i) then
            mismatch = mismatch + 1
        end
    end
    return mismatch == 0
end

function U.path_has_prefix(path, prefix)
    local sep = package.config:sub(1, 1)
    if prefix:sub(-1) ~= sep then prefix = prefix .. sep end
    return path == prefix:sub(1, -2) or path:sub(1, #prefix) == prefix
end

function U.html_escape(s)
    local map = { ['&'] = '&amp;', ['<'] = '&lt;', ['>'] = '&gt;', ['"'] = '&quot;', ["'"] = '&#39;' }
    return (tostring(s):gsub("[&<>\"]", map):gsub("'", map["'"]))
end

-- Open URL in default browser (portable)
function U.open_browser(url)
    if vim.ui and vim.ui.open then
        local ok = pcall(vim.ui.open, url)
        if ok then return end
    end
    local sys = (jit and jit.os) or uv.os_uname().sysname
    if sys == "Windows" or sys == "Windows_NT" then
        vim.schedule(function() vim.fn.jobstart({ "cmd.exe", "/c", "start", "", url }, { detach = true }) end)
    elseif sys == "OSX" or sys == "Darwin" then
        vim.schedule(function() vim.fn.jobstart({ "open", url }, { detach = true }) end)
    else
        vim.schedule(function() vim.fn.jobstart({ "xdg-open", url }, { detach = true }) end)
    end
end

return U
