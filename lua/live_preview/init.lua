-- lua/live_preview/init.lua
local util = require("live_preview.util")
local ws = require("live_preview.http.ws")
local ls_server = require("live_preview.server")
local ls_util = require("live_preview.http.util")
local file = require("live_preview.file")

local api = vim.api
local uv = vim.uv or vim.loop
local levels = vim.log.levels

local M = {}

---------------------------------------------------------------------------
-- Constants
---------------------------------------------------------------------------

local CONTENT_NAME = "content.md"
local INDEX_NAME = "index.html"
local ASSET_ROOT_NAME = "asset_root"
local ASSET_DIR = "assets/live_preview/"

local REFRESH_EVENTS = { "InsertLeave", "TextChanged", "TextChangedI", "TextChangedP", "BufWritePost" }
local CURSOR_EVENTS = { "CursorMoved", "CursorMovedI", "TextChangedP" }

-- Line offset between the nvim buffer and content.md, per buffer kind.
--   markdown: 0
--   mermaid file (.mmd/.mermaid): content.md gets a "```mermaid" line prepended
--   other: content.md holds only an extracted block, so there is no mapping (nil)
local LINE_OFFSET = { markdown = 0, mermaid = 1 }

local CDN = {
	["github-dark.min.css"] = "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github-dark.min.css",
	["github.min.css"] = "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github.min.css",
	["katex.min.css"] = "https://cdn.jsdelivr.net/npm/katex@0.16.28/dist/katex.min.css",
	["texmath.css"] = "https://cdn.jsdelivr.net/npm/markdown-it-texmath@1.0.0/css/texmath.css",
	["markdown-it.min.js"] = "https://cdn.jsdelivr.net/npm/markdown-it@14/dist/markdown-it.min.js",
	["morphdom-umd.min.js"] = "https://cdn.jsdelivr.net/npm/morphdom@2/dist/morphdom-umd.min.js",
	["highlight.min.js"] = "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js",
	["markdown-it-emoji.min.js"] = "https://cdn.jsdelivr.net/npm/markdown-it-emoji@3.0.0/dist/markdown-it-emoji.min.js",
	["markdown-it-footnote.min.js"] = "https://cdn.jsdelivr.net/npm/markdown-it-footnote@4.0.0/dist/markdown-it-footnote.min.js",
	["markdown-it-task-lists.min.js"] = "https://cdn.jsdelivr.net/npm/markdown-it-task-lists@2.1.1/dist/markdown-it-task-lists.min.js",
	["katex.min.js"] = "https://cdn.jsdelivr.net/npm/katex@0.16.28/dist/katex.min.js",
	["markdownItAnchor.umd.js"] = "https://unpkg.com/markdown-it-anchor@9.2.0/dist/markdownItAnchor.umd.js",
	["texmath.js"] = "https://cdn.jsdelivr.net/npm/markdown-it-texmath@1.0.0/texmath.js",
	["markdown-it-github-alerts.mjs"] = "https://unpkg.com/markdown-it-github-alerts@1.0.1/dist/index.mjs",
	["mermaid.min.js"] = "https://cdn.jsdelivr.net/npm/mermaid@12/dist/mermaid.min.js",
}

---------------------------------------------------------------------------
-- Config
---------------------------------------------------------------------------

M.config = {
	-- bind address; "0.0.0.0" for network access
	host = "127.0.0.1",
	open_browser = true,

	-- Notify when :refresh finds nothing to update.
	notify_on_refresh = false,

	-- Path to a custom CSS file.
	custom_css = "",

	debounce_ms = 100,

	-- "dark" | "light"
	default_theme = "light",

	-- Extra asset roots (symlink targets / directories images may be served from).
	extra_asset_roots = {},

	-- Render raw HTML embedded in markdown.
	allow_raw_html = true,

	-- YAML front matter (jekyll style --- ... --- at the top of the file):
	-- "panel" = strip it from the preview, show in a collapsible panel above
	-- "hide"  = strip it entirely
	-- "raw"   = leave it in the document (renders as markdown)
	yaml_mode = "panel",

	-- Fraction (0-1): 0.5 = middle of viewport, 1.0 = bottom edge
	bottom_padding = 0.5,
}

function M.setup(opts)
	M.config = vim.tbl_deep_extend("force", M.config, opts or {})
	M.config.bottom_padding = math.max(0, math.min(1, M.config.bottom_padding))
end

---------------------------------------------------------------------------
-- State
---------------------------------------------------------------------------

M._augroup = nil
M._follow_augroup = nil
M._active_bufnr = nil
M._last_text_by_buf = {}
M._written_tick = {}
M._server_instance = nil
M._refresh_timer = nil
M._refresh_bufnr = nil
M._workspace_dir = nil
M._token = nil -- live-server auth token (one per server lifetime)

---@type {line:integer, col:integer, mode:string, text:string}|nil
M._last_cursor = nil

---------------------------------------------------------------------------
-- Small helpers
---------------------------------------------------------------------------

local function notify(msg, level)
	vim.notify("Live Preview: " .. msg, level or levels.INFO)
end

local function is_number(x)
	return type(x) == "number" and x == x -- rejects NaN
end

local function clamp(value, lo, hi)
	return math.max(lo, math.min(hi, value))
end

local function buf_lines(bufnr)
	return api.nvim_buf_get_lines(bufnr, 0, -1, false)
end

local function mermaid_fence(body)
	return "```mermaid\n" .. body .. "\n```\n"
end

local function del_augroup(field)
	if M[field] then
		pcall(api.nvim_del_augroup_by_id, M[field])
		M[field] = nil
	end
end

--- Broadcast a message to all browsers. A missing server counts as success.
---@return boolean ok, any err
local function broadcast(msg)
	if not M._server_instance then
		return true
	end
	return pcall(ws.broadcast, M._server_instance, msg)
end

---@return "markdown"|"mermaid"|"other"
local function buf_kind(bufnr)
	if vim.bo[bufnr].filetype == "markdown" then
		return "markdown"
	end
	local name = api.nvim_buf_get_name(bufnr)
	if name:match("%.mmd$") or name:match("%.mermaid$") then
		return "mermaid"
	end
	return "other"
end

---@return integer|nil
local function content_line_offset(bufnr)
	return LINE_OFFSET[buf_kind(bufnr)]
end

---------------------------------------------------------------------------
-- Workspace & static assets
---------------------------------------------------------------------------

local function ensure_workspace(bufnr)
	local dir = util.workspace_for_buffer(bufnr)
	file.mkdirp(dir)
	return dir
end

local function require_asset(name)
	local path = file.resolve_asset(ASSET_DIR .. name)
	if not path then
		error(("Could not locate %s%s in runtimepath. Make sure the plugin ships it."):format(ASSET_DIR, name))
	end
	return path
end

--- Replace placeholders in order. Replacement values are computed lazily and
--- inserted literally (no gsub % escapes).
---@param content string
---@param replacements {[1]:string, [2]:fun():string}[]
local function fill_placeholders(content, replacements)
	for _, r in ipairs(replacements) do
		content = content:gsub(r[1], function()
			return r[2]()
		end)
	end
	return content
end

local function inject_custom_css(content)
	local css_path = M.config.custom_css
	if not css_path or css_path == "" then
		return content
	end

	local src = vim.fn.expand(css_path)
	local ok, css = pcall(file.read_text, src)
	if not (ok and css) then
		notify("custom_css not readable: " .. src, levels.WARN)
		return content
	end

	return (content:gsub("</head>", function()
		return "<style>\n" .. css .. "\n</style>\n</head>"
	end, 1))
end

local function write_index(dir)
	local content = file.read_text(require_asset("index.html"))
	local style_path = require_asset("style.css")

	content = fill_placeholders(content, {
		{ "__BOTTOM_PADDING__", function() return tostring(M.config.bottom_padding) end },
		{ "__STYLE_CSS__", function() return file.read_text(style_path) end },
		{ "__THEME__", function() return M.config.default_theme end },
		{ "__ALLOW_HTML__", function() return M.config.allow_raw_html ~= false and "true" or "false" end },
		{
			"__YAML_MODE__",
			function()
				local m = M.config.yaml_mode
				return (m == "hide" or m == "raw") and m or "panel"
			end,
		},
	})
	content = inject_custom_css(content)

	local dst = vim.fs.joinpath(dir, INDEX_NAME)
	file.write_text(dst, content)
	return dst
end

local function write_js(dir)
	local assets_dir = file.resolve_asset(ASSET_DIR)
	if not assets_dir then
		notify("Could not locate assets directory", levels.WARN)
		return
	end

	local ok, err = pcall(function()
		for name, ft in vim.fs.dir(assets_dir) do
			if ft == "file" and name:match("%.js$") then
				local src = file.resolve_asset(ASSET_DIR .. name)
				if src then
					file.write_text(vim.fs.joinpath(dir, name), file.read_text(src))
				end
			end
		end
	end)

	if not ok then
		notify("Failed to write JavaScript assets: " .. tostring(err), levels.ERROR)
	end
end

---------------------------------------------------------------------------
-- Mermaid extraction
---------------------------------------------------------------------------

-- Newer Neovim returns lists of nodes per capture from iter_matches(); older
-- versions return a single node. Accept both.
local function first_node(n)
	if type(n) == "table" then
		return n[1]
	end
	return n
end

--- Extract the mermaid fenced code block covering the cursor using Tree-sitter.
---@param bufnr integer
---@return string
local function extract_under_cursor(bufnr)
	local ok, parser = pcall(vim.treesitter.get_parser, bufnr, "markdown")
	if not ok then
		error("No Tree-sitter parser for markdown")
	end
	local root = parser:parse()[1]:root()

	local query = vim.treesitter.query.parse(
		"markdown",
		[[
		(fenced_code_block
		  (info_string) @info
		  (code_fence_content) @content)
		]]
	)

	local cur_row = api.nvim_win_get_cursor(0)[1] - 1

	for _, nodes in query:iter_matches(root, bufnr, 0, -1) do
		-- capture order follows the query: 1 = info, 2 = content
		local info, content = first_node(nodes[1]), first_node(nodes[2])
		local srow, _, erow = info:parent():range()
		if cur_row >= srow and cur_row <= erow then
			local info_txt = vim.treesitter.get_node_text(info, bufnr):lower()
			if info_txt:match("mermaid") then
				return vim.treesitter.get_node_text(content, bufnr)
			end
		end
	end
	error("Cursor is not inside a mermaid fenced code block")
end

--- Fallback: plain-text scan for the nearest mermaid block above the cursor.
---@return string|nil
local function fallback_scan(bufnr)
	local lines = buf_lines(bufnr)

	local start
	for i = api.nvim_win_get_cursor(0)[1], 1, -1 do
		if lines[i] and lines[i]:match("^%s*```%s*mermaid") then
			start = i
			break
		end
	end
	if not start then
		return nil
	end

	local acc = {}
	for i = start + 1, #lines do
		if lines[i]:match("^%s*```%s*$") then
			break
		end
		acc[#acc + 1] = lines[i]
	end
	return table.concat(acc, "\n")
end

---@return string
local function extract_mermaid_under_cursor(bufnr)
	local ok, text = pcall(extract_under_cursor, bufnr)
	if ok and text and #text > 0 then
		return text
	end

	local fallback = fallback_scan(bufnr)
	if not fallback or #fallback == 0 then
		error("No ```mermaid fenced code block found under (or above) the cursor")
	end
	return fallback
end

---------------------------------------------------------------------------
-- Content (markdown or mermaid, unified)
---------------------------------------------------------------------------

---@param bufnr integer
---@return string
local function get_content(bufnr)
	local kind = buf_kind(bufnr)
	if kind == "markdown" then
		return table.concat(buf_lines(bufnr), "\n")
	elseif kind == "mermaid" then
		return mermaid_fence(table.concat(buf_lines(bufnr), "\n"))
	end
	-- Other filetypes: extract the mermaid block under the cursor.
	return mermaid_fence(extract_mermaid_under_cursor(bufnr))
end

--- get_content, but returns nil on failure or empty content.
---@param bufnr integer
---@return string|nil
local function get_content_safe(bufnr)
	local ok, text = pcall(get_content, bufnr)
	if ok and text and #text > 0 then
		return text
	end
	return nil
end

local function write_content(dir, text, bufnr)
	local path = vim.fs.joinpath(dir, CONTENT_NAME)
	file.write_text(path, text)

	if bufnr then
		local name = api.nvim_buf_get_name(bufnr)
		local src_dir = name ~= "" and vim.fs.dirname(name) or nil
		if src_dir and src_dir ~= "" then
			pcall(file.write_text, vim.fs.joinpath(dir, ASSET_ROOT_NAME), src_dir)
		end
	end
	return path
end

---------------------------------------------------------------------------
-- Refresh (nvim -> browser content)
---------------------------------------------------------------------------

---@return boolean changed
local function maybe_refresh(bufnr)
	bufnr = bufnr or api.nvim_get_current_buf()

	-- Read the tick before the text: the content we write is at least this new.
	local tick = api.nvim_buf_get_changedtick(bufnr)
	local text = get_content_safe(bufnr)
	if not text then
		return false
	end

	if M._last_text_by_buf[bufnr] == text then
		-- The edit didn't change what the preview shows. Tell the browser, so a
		-- cursor message held back for this tick is released.
		M._written_tick[bufnr] = tick
		broadcast({ type = "tick", tick = tick })
		return false
	end

	local dir = M._workspace_dir or ensure_workspace(bufnr)
	write_content(dir, text, bufnr)
	M._last_text_by_buf[bufnr] = text
	M._written_tick[bufnr] = tick

	if M._server_instance then
		pcall(ls_server.reload, M._server_instance, CONTENT_NAME, tick)
	end
	return true
end

local function debounced_refresh(bufnr)
	M._refresh_bufnr = bufnr -- the timer refreshes whichever buffer asked last
	if not M._refresh_timer then
		M._refresh_timer = uv.new_timer()
	end
	if M._refresh_timer:is_active() then
		return
	end

	M._refresh_timer:start(
		M.config.debounce_ms,
		0,
		vim.schedule_wrap(function()
			local b = M._refresh_bufnr
			-- Buffer switched meanwhile: start() already wrote the new buffer.
			if b ~= M._active_bufnr then
				return
			end
			pcall(maybe_refresh, b)
		end)
	)
end

---------------------------------------------------------------------------
-- Cursor sync (nvim -> browser)
---------------------------------------------------------------------------

local function same_cursor(a, b)
	return a ~= nil and a.line == b.line and a.col == b.col and a.mode == b.mode and a.text == b.text
end

---@param bufnr integer
---@param force boolean|nil  send even if nothing changed (e.g. on start / browser hello)
---@param settled boolean|nil set by the deferred retry
local function send_cursor_sync(bufnr, force, settled)
	if not bufnr or not api.nvim_buf_is_valid(bufnr) then
		return
	end
	if api.nvim_get_current_buf() ~= bufnr then
		return
	end

	local offset = content_line_offset(bufnr)
	if not offset then
		return
	end

	local tick = api.nvim_buf_get_changedtick(bufnr)
	local mode = api.nvim_get_mode().mode

	-- Insert completion (modes "ic" / "ix") passes through transient states:
	-- nvim deletes the typed text, then re-inserts the match, and fires
	-- CursorMovedI in between. Re-read the state once the loop has settled.
	if not settled and (mode == "ic" or mode == "ix") then
		vim.schedule(function()
			send_cursor_sync(bufnr, force, true)
		end)
		return
	end

	local pos = api.nvim_win_get_cursor(0)
	local text = api.nvim_get_current_line()
	local cursor = { line = pos[1], col = pos[2], mode = mode, text = text }

	if not force and same_cursor(M._last_cursor, cursor) then
		return
	end
	M._last_cursor = cursor

	local ok, err = broadcast({
		type = "cursor",
		line = pos[1] - 1 + offset, -- 0-based line in content.md
		col = pos[2], -- 0-based BYTE column; JS converts to UTF-16
		mode = mode,
		text = text, -- current line, so the cursor is right before the debounced reload
		tick = tick,
		-- false while this edit's content hasn't been pushed yet: the browser
		-- holds the cursor until that content has rendered
		fresh = M._written_tick[bufnr] == tick,
		total = api.nvim_buf_line_count(bufnr) + offset,
	})
	if not ok then
		notify("cursor broadcast failed: " .. tostring(err), levels.ERROR)
	end
end

---------------------------------------------------------------------------
-- Cursor sync (browser -> nvim)
---------------------------------------------------------------------------

--- Move the cursor in the previewed buffer to a position sent by the browser.
---@param msg table {line: number (0-based, content.md), col: number (0-based BYTE col)}
local function goto_position(msg)
	local bufnr = M._active_bufnr
	if not bufnr or not api.nvim_buf_is_valid(bufnr) then
		return
	end

	-- Same mapping as nvim -> browser sync (nil = extracted mermaid block).
	local offset = content_line_offset(bufnr)
	if not offset then
		return
	end

	-- The message comes from the browser: validate before using it.
	if not is_number(msg.line) then
		return
	end

	-- Only move the cursor if the buffer is visible somewhere.
	local win = vim.fn.bufwinid(bufnr)
	if win == -1 then
		return
	end

	local lnum = clamp(math.floor(msg.line) - offset + 1, 1, api.nvim_buf_line_count(bufnr))
	local text = api.nvim_buf_get_lines(bufnr, lnum - 1, lnum, false)[1] or ""

	local col = is_number(msg.col) and math.floor(msg.col) or 0
	col = clamp(col, 0, math.max(#text - 1, 0))

	-- Snap to the start of a multibyte character.
	if col > 0 and vim.str_utf_start then
		local ok, back = pcall(vim.str_utf_start, text, col + 1)
		if ok and type(back) == "number" then
			col = col + back
		end
	end

	if not pcall(api.nvim_win_set_cursor, win, { lnum, col }) then
		return
	end

	-- Pre-seed the dedupe state used by send_cursor_sync, so the CursorMoved
	-- event this triggers is not echoed back to the browser (which would
	-- scroll the page under the user's mouse).
	M._last_cursor = { line = lnum, col = col, mode = api.nvim_get_mode().mode, text = text }

	-- nvim may not be the focused window; make sure the move is drawn.
	pcall(vim.cmd, "redraw")
end

--- Handle messages sent by the browser over the websocket (libuv callback).
local function on_browser_message(raw)
	vim.schedule(function()
		local ok, msg = pcall(vim.json.decode, raw)
		if not ok or type(msg) ~= "table" then
			return
		end

		if msg.type == "hello" then
			send_cursor_sync(M._active_bufnr, true)
		elseif msg.type == "goto" then
			goto_position(msg)
		end
	end)
end

---------------------------------------------------------------------------
-- Autocmds
---------------------------------------------------------------------------

local function set_autocmds_for_buffer(bufnr)
	del_augroup("_augroup")
	M._augroup = api.nvim_create_augroup("MarkdownPreviewAuto", { clear = true })

	api.nvim_create_autocmd(REFRESH_EVENTS, {
		group = M._augroup,
		buffer = bufnr,
		callback = function()
			debounced_refresh(bufnr)
		end,
		desc = "Live Preview auto-refresh (debounced)",
	})

	api.nvim_create_autocmd(CURSOR_EVENTS, {
		group = M._augroup,
		buffer = bufnr,
		callback = function()
			send_cursor_sync(bufnr)
		end,
		desc = "Live Preview cursor sync",
	})

	-- Not buffer-local on purpose: ModeChanged's pattern is matched against
	-- "old:new" modes, so buffer-local registration is unreliable. The
	-- callback checks the buffer itself.
	api.nvim_create_autocmd("ModeChanged", {
		group = M._augroup,
		callback = function()
			if api.nvim_get_current_buf() == bufnr then
				send_cursor_sync(bufnr)
			end
		end,
		desc = "Live Preview cursor shape sync",
	})
end

local function set_follow_autocmd()
	del_augroup("_follow_augroup")
	M._follow_augroup = api.nvim_create_augroup("MarkdownPreviewFollow", { clear = true })

	api.nvim_create_autocmd("BufEnter", {
		group = M._follow_augroup,
		callback = function(args)
			local bufnr = args.buf
			if bufnr == M._active_bufnr then return end
			if vim.bo[bufnr].buftype ~= "" then return end -- skip help, terminals, etc.
			if content_line_offset(bufnr) == nil then return end -- only markdown / .mmd / .mermaid

			-- Run after the buffer switch settles; start() reads the current buffer.
			vim.schedule(function()
				if api.nvim_get_current_buf() == bufnr then
					M.start()
				end
			end)
		end,
		desc = "Live Preview: follow the current markdown buffer",
	})
end

---------------------------------------------------------------------------
-- CDN mapping
---------------------------------------------------------------------------

--- Maps a requested asset name to a CDN URL.
---   cdn_map("katex.min.css")            -> url
---   cdn_map("iconify-json", "mdi")      -> url
local function cdn_map(name, ...)
	local nargs = select("#", ...)

	if nargs == 0 then
		return CDN[name]
	elseif nargs == 1 then
		if name == "iconify-json" then
			return ("https://unpkg.com/@iconify-json/%s@1/icons.json"):format((...))
		end
		return nil
	end

	vim.schedule(function()
		notify("no cdn mapping: " .. tostring(name), levels.ERROR)
	end)
end

---------------------------------------------------------------------------
-- Server helpers
---------------------------------------------------------------------------

--- UDP trick to find the outbound LAN IP.
local function lan_ip()
	local udp = uv.new_udp()
	if not udp then
		return "127.0.0.1"
	end
	local ok = pcall(function()
		udp:connect("8.8.8.8", 80)
	end)
	local addr = ok and udp:getsockname()
	pcall(function()
		udp:close()
	end)
	return (addr and addr.ip) or "127.0.0.1"
end

--- URL the browser opens. Embeds the auth token when one exists.
local function browser_url(port)
	local host = (M.config.host == "0.0.0.0") and lan_ip() or M.config.host
	local url = ("http://%s:%d/"):format(host, port)
	if M._token and M._token ~= "" then
		url = url .. "?t=" .. M._token
	end
	return url
end

local function open_browser_soon(port)
	vim.defer_fn(function()
		util.open_in_browser(browser_url(port))
	end, 200)
end

--- Paths the server must not serve as user assets.
local function protected_paths()
	return {
		"^/" .. vim.pesc(CONTENT_NAME) .. "$",
		"^/" .. vim.pesc(ASSET_ROOT_NAME) .. "$",
		"^/$",
		"^/" .. vim.pesc(INDEX_NAME) .. "$",
	}
end

--- Directory of the previewed buffer's source file, or nil.
local function current_asset_root()
	local dir = M._workspace_dir
	if not dir then
		return nil
	end
	local ok, data = pcall(file.read_text, vim.fs.joinpath(dir, ASSET_ROOT_NAME))
	if not ok or not data or data == "" then
		return nil
	end
	return (data:gsub("%s+$", ""))
end

---@return boolean started
local function start_server(shared_dir, dir)
	local ok, inst = pcall(ls_server.start, {
		host = M.config.host,
		roots = { shared_dir, dir },
		headers = { ["cache-control"] = "no-cache" },
		-- The browser sends {type="hello"} when its websocket opens; reply
		-- with the current cursor so a fresh/reconnected tab is in sync.
		on_message = on_browser_message,
		token = M._token,
		protected_paths = protected_paths(),
		asset_root = current_asset_root,
		extra_asset_roots = M.config.extra_asset_roots,
		cdn_map = cdn_map,
		cdn_root = vim.fs.joinpath(shared_dir, "cdn"),
	})
	if not ok then
		notify(("failed to start server %s"):format(tostring(inst)), levels.ERROR)
		return false
	end

	M._server_instance = inst
	notify(("runs on %s"):format(browser_url(inst.port)))

	if M.config.open_browser then
		open_browser_soon(inst.port)
	end
	return true
end

--- Server already running: point it at the current buffer's workspace.
local function retarget_server(shared_dir, dir, tick)
	local inst = M._server_instance
	pcall(ls_server.update_target, inst, { shared_dir, dir })
	pcall(ls_server.reload, inst, CONTENT_NAME, tick)

	-- No browser tab connected: reopen.
	if M.config.open_browser and ls_server.connected_client_count(inst) == 0 then
		open_browser_soon(inst.port)
	end
end

---------------------------------------------------------------------------
-- Public API
---------------------------------------------------------------------------

function M.start()
	local bufnr = api.nvim_get_current_buf()
	local tick = api.nvim_buf_get_changedtick(bufnr)

	local ok_content, text = pcall(get_content, bufnr)
	if not ok_content then
		notify(tostring(text), levels.ERROR)
		return
	end

	M._active_bufnr = bufnr
	M._last_cursor = nil -- force the first cursor message after (re)start

	local dir = ensure_workspace(bufnr)
	M._workspace_dir = dir
	local shared_dir = util.shared_workspace()

	if not M._token or M._token == "" then
		M._token = ls_util.random_token(16)
	end

	-- Shared content (overwrites old copies).
	write_js(shared_dir)
	write_index(shared_dir)

	-- Per-buffer content.
	write_content(dir, text, bufnr)
	M._last_text_by_buf[bufnr] = text
	M._written_tick[bufnr] = tick

	set_autocmds_for_buffer(bufnr)
	set_follow_autocmd()

	if M._server_instance then
		retarget_server(shared_dir, dir, tick)
	elseif not start_server(shared_dir, dir) then
		return
	end

	-- Push an initial cursor position. The browser may not have its websocket
	-- open yet; the "hello" handshake (see on_browser_message) covers that case.
	vim.defer_fn(function()
		send_cursor_sync(bufnr, true)
	end, 500)
end

function M.refresh()
	local changed = maybe_refresh(api.nvim_get_current_buf())
	if not changed and M.config.notify_on_refresh then
		notify("no changes detected")
	end
end

function M.stop()
	del_augroup("_augroup")
	del_augroup("_follow_augroup")

	if M._server_instance then
		pcall(ls_server.stop, M._server_instance)
		M._server_instance = nil
	end

	if M._refresh_timer then
		M._refresh_timer:stop()
		M._refresh_timer:close()
		M._refresh_timer = nil
	end

	M._active_bufnr = nil
	M._last_text_by_buf = {}
	M._written_tick = {}
	M._workspace_dir = nil
	M._last_cursor = nil
	M._token = nil
end

return M
