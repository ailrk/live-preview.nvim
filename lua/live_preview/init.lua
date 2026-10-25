-- lua/live_preview/init.lua
local ts = require("live_preview.ts")
local util = require("live_preview.util")
local ls_ws = require("live_server.http.ws")
local ls_server = require("live_server.server")
local ls_util = require("live_server.util")
local M = {}



M.config = {
	-- 0 = auto (the OS picks a free port)
	port = 0,

	-- bind address; "0.0.0.0" for network access (e.g. over SSH)
	host = "127.0.0.1",
	open_browser = true,

	-- nil = system default browser. String for app/binary name (e.g. "Firefox",
	-- "google-chrome"). Table for full command with args (URL is appended).
	-- On macOS, string values are passed via `open -a <name>`.
	browser = nil,

	content_name = "content.md",
	index_name = "index.html",

	-- Path to a CSS file injected after the bundled styles, so user rules win
	-- the cascade without !important. Supports ~ and $VARS. "" = disabled.
	custom_css = "",

	-- nil = per-buffer workspace (recommended); set a path to override
	workspace_dir = nil,

	overwrite_index_on_start = true,

	auto_refresh_events = { "InsertLeave", "TextChanged", "TextChangedI", "BufWritePost" },
	debounce_ms = 300,
	notify_on_refresh = false,

	-- "js" = browser-side mermaid.js (default, zero deps)
	-- "rust" = pre-render via mermaid-rs-renderer (mmdr) CLI (~400x faster)
	mermaid_renderer = "js",

	-- Load ELK layout engine for mermaid diagrams (requires internet; adds ~800 KB).
	-- Enables %%{init: {"layout": "elk"}}%% in diagrams.
	mermaid_elk = false,

	scroll_sync = true, -- sync browser scroll + cursor to the nvim cursor

	-- "dark" or "light"; determines the initial theme of the preview page
	default_theme = "light",

	-- Extra asset roots (symlink targets / directories images may be served from).
	extra_asset_roots = {},

	-- Render raw HTML embedded in markdown (GitHub-like). Set false when
	-- previewing untrusted markdown: raw HTML runs inside the preview page.
	allow_raw_html = true,

	-- YAML front matter (--- ... --- at the top of the file):
	-- "panel" = strip it from the preview, show in a collapsible panel above
	-- "hide"  = strip it entirely
	-- "raw"   = leave it in the document (renders as markdown)
	yaml_mode = "panel",

	-- Fraction (0–1): vertical position of the final line when scrolled to end.
	--- 0.5 = middle of viewport (default), 1.0 = bottom edge (no extra space)
	bottom_padding = 0.5,

	hooks = {
		-- fun(url: string)|nil — called after preview starts; receives the preview URL
		on_start = nil,
		-- fun()|nil — called after preview stops
		on_stop = nil,
	},
}


function M.setup(opts)
	M.config = vim.tbl_deep_extend("force", M.config, opts or {})
	M.config.bottom_padding = math.max(0, math.min(1, M.config.bottom_padding))
	M._mmdr_available = nil -- reset so next check re-probes
end


-- Internal state
M._augroup = nil
M._active_bufnr = nil
M._last_text_by_buf = {}
M._server_instance = nil
M._debounce_seq = 0
M._workspace_dir = nil
M._mmdr_available = nil -- nil = unchecked, true/false after probe
M._token = nil          -- live-server auth token (one per server lifetime)
M._follow_augroup = nil --

---@type {line:integer, col:integer, mode:string, text:string}|nil
M._last_cursor = nil


local function host_is_loopback()
	return M.config.host == "127.0.0.1" or M.config.host == "localhost"
end


---------------------------------------------------------------------------
-- Workspace
---------------------------------------------------------------------------

local function resolve_workspace(bufnr)
	if M.config.workspace_dir then
		return M.config.workspace_dir
	end
	return util.workspace_for_buffer(bufnr)
end

local function ensure_workspace(bufnr)
	local dir = resolve_workspace(bufnr)
	util.mkdirp(dir)
	return dir
end

---------------------------------------------------------------------------
-- Index HTML
---------------------------------------------------------------------------

local function write_index(dir)
	local dst = vim.fs.joinpath(dir, M.config.index_name)
	local src = util.resolve_asset("assets/index.html")
	if not src then
		error("Could not locate assets/index.html in runtimepath. Make sure the plugin ships it.")
	end
	local content = util.read_text(src)

	local style_css = util.resolve_asset("assets/style.css")
	if not style_css then
		error("Could not locate assets/style.css")
	end

	local main_js = util.resolve_asset("assets/main.js")
	if not main_js then
		error("Could not locate assets/main.js")
	end

	-- gsub with function replacement: avoids the "%n is a capture reference"
	-- escape problem if any substituted value contains '%'.
	content = content:gsub("__BOTTOM_PADDING__", function() return tostring(M.config.bottom_padding) end)
	content = content:gsub("__MERMAID_ELK__", function() return M.config.mermaid_elk and "true" or "false" end)
	content = content:gsub("__STYLE_CSS__", function() return util.read_text(style_css) end)
	content = content:gsub("__MAIN_JS__", function() return util.read_text(main_js) end)

	-- Anchor to the attribute: index.html also contains the bare placeholder
	-- as a JS sentinel, and substituting that too breaks auth (issue #31).
	-- Bake the token only on loopback binds: on a network bind the index is
	-- served to any peer that can reach the port, and a baked token would
	-- defeat the auth entirely (the browser gets it via ?t= instead).
	content = content:gsub('data%-live%-token="__LIVE_TOKEN__"', function()
		return 'data-live-token="' .. (host_is_loopback() and M._token or "") .. '"'
	end)
	content = content:gsub("__THEME__", function() return M.config.default_theme end)
	content = content:gsub("__ALLOW_HTML__", function() return M.config.allow_raw_html ~= false and "true" or "false" end)
	content = content:gsub("__YAML_MODE__", function()
		local m = M.config.yaml_mode
		if m ~= "hide" and m ~= "raw" then m = "panel" end
		return m
	end)

	-- Inline custom CSS after the bundled styles so user rules win the cascade.
	if M.config.custom_css and M.config.custom_css ~= "" then
		local css_src = vim.fn.expand(M.config.custom_css)
		local ok, css = pcall(util.read_text, css_src)
		if ok and css then
			content = content:gsub("</head>", function()
				return "<style>\n" .. css .. "\n</style>\n</head>"
			end, 1)
		else
			vim.notify("Markdown Preview: custom_css not readable: " .. css_src, vim.log.levels.WARN)
		end
	end

	util.write_text(dst, content)
	return dst
end


local function write_index_if_needed(dir)
	if M.config.overwrite_index_on_start then
		return write_index(dir)
	end
	local dst = vim.fs.joinpath(dir, M.config.index_name)
	if not util.file_exists(dst) then
		return write_index(dir)
	end
	-- Rewrite a persisted index whose baked token no longer matches what this
	-- session serves. Covers a fresh token after restart AND a loopback<->
	-- network switch (which flips whether the token is baked at all) — a stale
	-- non-empty token on a network bind would otherwise 401 every request.
	local want = 'data-live-token="' .. (host_is_loopback() and (M._token or "") or "") .. '"'
	local ok, existing = pcall(util.read_text, dst)
	if not ok or not existing:find(want, 1, true) then
		return write_index(dir)
	end
	return dst
end

---------------------------------------------------------------------------
-- Mermaid extraction
---------------------------------------------------------------------------

local function extract_mermaid_under_cursor_strict(bufnr)
	local ok, text = pcall(ts.extract_under_cursor, bufnr)
	if ok and text and #text > 0 then
		return text
	end
	return nil
end

local function extract_mermaid_under_cursor(bufnr)
	local text = extract_mermaid_under_cursor_strict(bufnr)
	if text and #text > 0 then
		return text
	end
	local fallback = ts.fallback_scan(bufnr)
	if not fallback or #fallback == 0 then
		error("No ```mermaid fenced code block found under (or above) the cursor")
	end
	return fallback
end

---------------------------------------------------------------------------
-- mermaid-rs-renderer (mmdr) integration
---------------------------------------------------------------------------

---Check if mmdr CLI is available; caches result after first probe.
---@return boolean
local function is_mmdr_available()
	if M._mmdr_available ~= nil then
		return M._mmdr_available
	end
	M._mmdr_available = vim.fn.executable("mmdr") == 1
	if not M._mmdr_available then
		vim.notify(
			"Markdown Preview: mermaid_renderer='rust' but `mmdr` not found in PATH.\n"
				.. "Install: cargo install mermaid-rs-renderer\n"
				.. "Falling back to browser-side mermaid.js.",
			vim.log.levels.WARN
		)
	end
	return M._mmdr_available
end


---Render a single mermaid diagram source via mmdr CLI.
---@param source string Raw mermaid diagram text
---@return string|nil svg SVG string on success
---@return string|nil err Error message on failure
local function render_mermaid_via_mmdr(source)
	local result = vim.fn.system({ "mmdr", "-e", "svg" }, source)
	if vim.v.shell_error ~= 0 then
		return nil, result
	end
	return result, nil
end


-- Expand button SVG used in pre-rendered blocks (matches browser-side fence renderer)
local EXPAND_BTN_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none">'
	.. '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
	.. "</svg>"


local function count_newlines(s)
	local _, n = s:gsub("\n", "")
	return n
end


---Pre-render ```mermaid fences via mmdr, replacing them with HTML blocks.
---Failed renders leave the original fence untouched for browser-side fallback.
---The replacement keeps the SAME number of lines as the original fence, so
---line numbers in content.md still match the nvim buffer (cursor sync).
---@param text string Full markdown text
---@return string text Markdown with pre-rendered mermaid blocks
local function prerender_mermaid_blocks(text)
	local rust_idx = 0
	local out = {}
	local pos = 1

	while true do
		-- Find opening ```mermaid fence
		local fence_start, fence_end = text:find("\n```mermaid%s*\n", pos)
		if not fence_start then
			-- Also check at the very start of the document
			if pos == 1 then
				fence_start, fence_end = text:find("^```mermaid%s*\n")
			end
			if not fence_start then
				break
			end
		end

		-- Find closing ```
		local close_start, close_end = text:find("\n```%s*\n", fence_end)
		if not close_start then
			-- Try closing at end of file
			close_start, close_end = text:find("\n```%s*$", fence_end)
			if not close_start then
				break
			end
		end

		-- Extract mermaid source between fences
		local source = text:sub(fence_end + 1, close_start - 1)
		if source and #source > 0 then
			local svg, _err = render_mermaid_via_mmdr(source)
			if svg then
				rust_idx = rust_idx + 1
				local block_id = "mmd-rust-" .. rust_idx
				local encoded = vim.uri_encode(source, "rfc2396")

				-- Collapse newlines inside the SVG: a multi-line (or blank-line
				-- containing) SVG would both end the HTML block early and
				-- change the line count.
				svg = svg:gsub("\r?\n", " ")

				local html_block = '<div class="mermaid-block mermaid-rendered" id="'
					.. block_id
					.. '" data-mermaid-source="'
					.. encoded
					.. '" data-graph="mermaid" data-prerendered="true">'
					.. '<button class="mermaid-expand-btn" title="Expand diagram" data-expand="'
					.. block_id
					.. '">'
					.. EXPAND_BTN_SVG
					.. "</button>"
					.. '<div class="mermaid-svg-wrap">'
					.. svg
					.. "</div>"
					.. "</div>"

				-- Preserve line count: replacement is "\n" .. block .. "\n" (2 newlines),
				-- so pad with however many newlines the original segment had beyond that.
				local original = text:sub(fence_start, close_end)
				local pad = math.max(0, count_newlines(original) - 2)

				-- Append text before fence + the HTML block
				out[#out + 1] = text:sub(pos, fence_start - 1)
				out[#out + 1] = "\n" .. html_block .. "\n" .. string.rep("\n", pad)
				pos = close_end + 1
			else
				-- mmdr failed for this block — leave fence untouched for JS fallback
				out[#out + 1] = text:sub(pos, close_end)
				pos = close_end + 1
			end
		else
			out[#out + 1] = text:sub(pos, close_end)
			pos = close_end + 1
		end
	end

	-- Append remaining text
	out[#out + 1] = text:sub(pos)
	return table.concat(out)
end


---------------------------------------------------------------------------
-- Content writing (unified: markdown or mermaid)
---------------------------------------------------------------------------

---Get the content to write based on filetype.
---Markdown buffers: entire buffer.
---Mermaid files (.mmd, .mermaid): entire buffer wrapped in mermaid fence.
---Others: mermaid block under cursor wrapped in fence.
---@param bufnr integer
---@return string
local function get_content(bufnr)
	local text
	local ft = vim.bo[bufnr].filetype
	if ft == "markdown" then
		local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
		text = table.concat(lines, "\n")
	elseif vim.api.nvim_buf_get_name(bufnr):match("%.mmd$")
		or vim.api.nvim_buf_get_name(bufnr):match("%.mermaid$") then
		-- .mmd / .mermaid files: treat entire buffer as mermaid
		local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
		text = "```mermaid\n" .. table.concat(lines, "\n") .. "\n```\n"
	else
		-- Other filetypes: extract mermaid block under cursor, wrap in code fence
		local mermaid_text = extract_mermaid_under_cursor(bufnr)
		text = "```mermaid\n" .. mermaid_text .. "\n```\n"
	end

	-- Pre-render mermaid blocks via mmdr if configured. Skipped when raw HTML
	-- is disabled: pre-rendering injects <svg> markup into content.md, which
	-- markdown-it would escape to literal text under html:false. The browser-
	-- side renderer handles the fences instead (it doesn't need raw HTML).
	if M.config.mermaid_renderer == "rust" and M.config.allow_raw_html ~= false and is_mmdr_available() then
		text = prerender_mermaid_blocks(text)
	end

	return text
end


---Same as get_content but never errors (returns nil on failure).
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
	local path = vim.fs.joinpath(dir, M.config.content_name)
	util.write_text(path, text)
	-- Sidecar recording the source file's directory. The server's asset
	-- route resolves relative image paths against it, and re-reads it per
	-- request so buffer switches retarget it.
	if bufnr then
		local name = vim.api.nvim_buf_get_name(bufnr)
		local src_dir = name ~= "" and vim.fs.dirname(name) or nil
		if src_dir and src_dir ~= "" then
			pcall(util.write_text, vim.fs.joinpath(dir, "asset_root"), src_dir)
		end
	end
	return path
end


---------------------------------------------------------------------------
-- Refresh logic
---------------------------------------------------------------------------


local function maybe_refresh(bufnr, silent)
	bufnr = bufnr or vim.api.nvim_get_current_buf()

	local text = get_content_safe(bufnr)
	if not text then
		return false
	end

	if M._last_text_by_buf[bufnr] == text then
		return false
	end

	local dir = M._workspace_dir or ensure_workspace(bufnr)
	write_content(dir, text, bufnr)
	M._last_text_by_buf[bufnr] = text

	-- Notify live-server of the content change for immediate SSE push
	if M._server_instance then
		pcall(ls_server.reload, M._server_instance, M.config.content_name)
	end

	if not silent and M.config.notify_on_refresh then
		vim.notify("Markdown preview updated", vim.log.levels.INFO)
	end
	return true
end


local function debounced_refresh(bufnr)
	M._debounce_seq = M._debounce_seq + 1
	local this_call = M._debounce_seq
	vim.defer_fn(function()
		if this_call ~= M._debounce_seq then
			return
		end
		pcall(maybe_refresh, bufnr, true)
	end, M.config.debounce_ms)
end


---------------------------------------------------------------------------
-- Cursor sync (nvim -> browser)
---------------------------------------------------------------------------

-- Line offset between the nvim buffer and content.md.
-- markdown: 0. .mmd/.mermaid: content.md gets a "```mermaid" line prepended.
-- anything else: content.md holds only an extracted block, so no mapping.
local function content_line_offset(bufnr)
	if vim.bo[bufnr].filetype == "markdown" then return 0 end
	local name = vim.api.nvim_buf_get_name(bufnr)
	if name:match("%.mmd$") or name:match("%.mermaid$") then return 1 end
	return nil
end


---@param bufnr integer
---@param force boolean|nil  send even if nothing changed (e.g. on start / browser hello)
local function send_cursor_sync(bufnr, force)
	if not M.config.scroll_sync then return end
	if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then return end
	if vim.api.nvim_get_current_buf() ~= bufnr then return end

	local offset = content_line_offset(bufnr)
	if not offset then return end

	local pos = vim.api.nvim_win_get_cursor(0)
	local mode = vim.api.nvim_get_mode().mode
	local text = vim.api.nvim_get_current_line()

	local last = M._last_cursor
	if not force and last
		and last.line == pos[1] and last.col == pos[2]
		and last.mode == mode and last.text == text then
		return
	end
	M._last_cursor = { line = pos[1], col = pos[2], mode = mode, text = text }

	if M._server_instance then
		local ok, err = pcall(ls_ws.broadcast, M._server_instance, {
			type = "cursor",
			line = pos[1] - 1 + offset, -- 0-based line in content.md
			col = pos[2],               -- 0-based BYTE column; JS converts to UTF-16
			mode = mode,
			text = text,                -- current line, so the cursor is right before the debounced reload
			total = vim.api.nvim_buf_line_count(bufnr) + offset,
		})
		if not ok then
			vim.notify("Markdown Preview: cursor broadcast failed: " .. tostring(err), vim.log.levels.ERROR)
		end
	end
end

---------------------------------------------------------------------------
-- Cursor sync (browser -> nvim)
---------------------------------------------------------------------------

---Move the cursor in the previewed buffer to a position sent by the browser.
---@param msg table {line: number (0-based, content.md), col: number (0-based BYTE col)}
local function goto_position(msg)
	if not M.config.scroll_sync then return end

	local bufnr = M._active_bufnr
	if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then return end

	-- Same mapping as nvim -> browser sync (nil = extracted mermaid block, no mapping)
	local offset = content_line_offset(bufnr)
	if not offset then return end

	-- The message comes from the browser: validate everything.
	if type(msg.line) ~= "number" or msg.line ~= msg.line then return end

	-- Only move the cursor if the buffer is visible somewhere.
	local win = vim.fn.bufwinid(bufnr)
	if win == -1 then return end

	local count = vim.api.nvim_buf_line_count(bufnr)
	local lnum = math.max(1, math.min(count, math.floor(msg.line) - offset + 1))
	local text = vim.api.nvim_buf_get_lines(bufnr, lnum - 1, lnum, false)[1] or ""

	local col = type(msg.col) == "number" and msg.col == msg.col and math.floor(msg.col) or 0
	col = math.max(0, math.min(math.max(#text - 1, 0), col))

	-- Snap to the start of a multibyte character.
	if col > 0 and vim.str_utf_start then
		local ok, back = pcall(vim.str_utf_start, text, col + 1)
		if ok and type(back) == "number" then col = col + back end
	end

	if not pcall(vim.api.nvim_win_set_cursor, win, { lnum, col }) then return end

	-- Pre-seed the dedupe state used by send_cursor_sync, so the CursorMoved
	-- event this triggers is not echoed back to the browser (which would
	-- scroll the page under the user's mouse).
	M._last_cursor = {
		line = lnum,
		col = col,
		mode = vim.api.nvim_get_mode().mode,
		text = text,
	}

	-- nvim may not be the focused window; make sure the move is drawn.
	pcall(vim.cmd, "redraw")
end


-- Handle messages sent by the browser over the websocket.
-- Runs in a libuv callback, so hop onto the main loop before touching nvim.
local function on_browser_message(raw)
	vim.schedule(function()
		local ok, msg = pcall(vim.json.decode, raw)
		if not ok or type(msg) ~= "table" then return end

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
	if M._augroup then
		pcall(vim.api.nvim_del_augroup_by_id, M._augroup)
	end
	M._augroup = vim.api.nvim_create_augroup("MarkdownPreviewAuto", { clear = true })

    for _, ev in ipairs(M.config.auto_refresh_events) do
        vim.api.nvim_create_autocmd(ev, {
            group = M._augroup,
            buffer = bufnr,
            callback = function()
                debounced_refresh(bufnr)
            end,
            desc = "Markdown Preview auto-refresh (debounced)",
        })
    end

	for _, ev in ipairs({ "CursorMoved", "CursorMovedI" }) do
		vim.api.nvim_create_autocmd(ev, {
			group = M._augroup,
			buffer = bufnr,
			callback = function() send_cursor_sync(bufnr) end,
			desc = "Markdown Preview cursor sync",
		})
	end

	-- Not buffer-local on purpose: ModeChanged's pattern is matched against
	-- "old:new" modes, so buffer-local registration is unreliable. The
	-- callback checks the buffer itself.
	vim.api.nvim_create_autocmd("ModeChanged", {
		group = M._augroup,
		callback = function()
			if vim.api.nvim_get_current_buf() == bufnr then send_cursor_sync(bufnr) end
		end,
		desc = "Markdown Preview cursor shape sync",
	})
end


local function set_follow_autocmd()
	if M._follow_augroup then
		pcall(vim.api.nvim_del_augroup_by_id, M._follow_augroup)
	end
	M._follow_augroup = vim.api.nvim_create_augroup("MarkdownPreviewFollow", { clear = true })

	vim.api.nvim_create_autocmd("BufEnter", {
		group = M._follow_augroup,
		callback = function(args)
			local bufnr = args.buf
			if bufnr == M._active_bufnr then return end
			if vim.bo[bufnr].buftype ~= "" then return end   -- skip help, terminals, etc.
			if content_line_offset(bufnr) == nil then return end -- only markdown / .mmd / .mermaid
			-- Run after the buffer switch settles; start() reads the current buffer.
			vim.schedule(function()
				if vim.api.nvim_get_current_buf() == bufnr then
					M.start()
				end
			end)
		end,
		desc = "Markdown Preview: follow the current markdown buffer",
	})
end

---------------------------------------------------------------------------
-- Public API
---------------------------------------------------------------------------

-- When bound to 0.0.0.0 detect the outbound LAN IP via a UDP connect trick
-- (no packets are sent; it just lets the kernel pick the right interface).
local function lan_ip()
	local udp = vim.loop.new_udp()
	if not udp then return "127.0.0.1" end
	local ok = pcall(function() udp:connect("8.8.8.8", 80) end)
	local addr = ok and udp:getsockname()
	pcall(function() udp:close() end)
	return (addr and addr.ip) or "127.0.0.1"
end


-- Build the URL the browser opens to. Embeds the auth token when one exists
-- so the first request includes it (the page then stashes it in
-- sessionStorage for refreshes).
local function browser_url(port)
	local display_host = (M.config.host == "0.0.0.0") and lan_ip() or M.config.host
	local base = ("http://%s:%d/"):format(display_host, port)
    local url = M._token and M._token ~= "" and base .. "?t=" .. M._token or base
    vim.notify("[live-preview]: serving on " .. url)
	return url
end


function M.start()
	local bufnr = vim.api.nvim_get_current_buf()
	M._active_bufnr = bufnr
	M._last_cursor = nil -- force the first cursor message after (re)start

	local ok_content, text = pcall(get_content, bufnr)
	if not ok_content then
		vim.notify("Markdown Preview: " .. tostring(text), vim.log.levels.ERROR)
		return
	end

	local dir = ensure_workspace(bufnr)
	M._workspace_dir = dir

	-- One token per server lifetime, reused across retargets. Must exist
	-- before writing index.html, which bakes it in via __LIVE_TOKEN__.
	if not M._token or M._token == "" then
		M._token = ls_util.random_token(16)
	end

	write_index_if_needed(dir)
	write_content(dir, text, bufnr)
	M._last_text_by_buf[bufnr] = text

	set_autocmds_for_buffer(bufnr)
    set_follow_autocmd()

	-- Patterns matching workspace-served files that require ?t=<token>.
	-- vim.pesc escapes every Lua-pattern magic char, so custom content_name /
	-- index_name values containing '-', '+', '.', etc. still gate correctly.
	local content_path_pattern = "^/" .. vim.pesc(M.config.content_name) .. "$"

	-- The asset_root sidecar is gated too: it holds the source file's
	-- directory path, which is nobody's business but ours.
	local protected = { content_path_pattern, "^/asset_root$" }
	if not host_is_loopback() then
		-- On a network bind the index page must be gated too: it is the
		-- browser's bootstrap document, and serving it openly would hand the
		-- preview to any peer that can reach the port. The tokenized ?t= URL
		-- (printed by hooks.on_start / opened by the browser) unlocks it.
		table.insert(protected, "^/$")
		table.insert(protected, "^/" .. vim.pesc(M.config.index_name) .. "$")
	end

	-- Relative image support needs the asset route in live-server. The two
	-- plugins are versioned independently, so warn (once) if the installed
	-- live-server predates it — images will 404 until it's updated.
	if not (ls_server.features and ls_server.features.asset_route) and not M._warned_no_asset_route then
		M._warned_no_asset_route = true
		vim.notify(
			"Markdown Preview: relative images need a newer live-server.nvim (with the asset route).\n"
				.. "Update live-server.nvim, or relative images will not load.",
			vim.log.levels.WARN
		)
	end

	local index_path = vim.fs.joinpath(dir, M.config.index_name)

	if not M._server_instance then
		local ok, inst = pcall(ls_server.start, {
			port = M.config.port,
			host = M.config.host,
			root = dir,
			default_index = index_path,
			headers = { ["cache-control"] = "no-cache" },
			-- No cors: the preview page is same-origin and remote.lua talks raw
			-- TCP. A wildcard ACAO would let any website in the user's browser
			-- read the token out of the (unauthenticated) index page.
			live = {
				enabled = true,
				inject_script = false,
				debounce = 100,
			},
			-- The browser sends {type="hello"} when its websocket opens; reply
			-- with the current cursor so a fresh/reconnected tab is in sync.
			on_message = on_browser_message,
			features = { dirlist = { enabled = false } },
			token = M._token,
			protected_paths = protected,
			-- Resolve relative image paths against the source file's dir
			-- (issue #17). Read per request so buffer switches retarget it
			-- via the sidecar.
			asset_root = function()
				local ws = M._workspace_dir
				if not ws then return nil end
				local ok_read, data = pcall(util.read_text, vim.fs.joinpath(ws, "asset_root"))
				if not ok_read or not data or data == "" then return nil end
				return (data:gsub("%s+$", ""))
			end,
			extra_asset_roots = M.config.extra_asset_roots,
		})
		if not ok then
			vim.notify(
				("Markdown Preview: failed to start server (port %s) — %s"):format(tostring(M.config.port), tostring(inst)),
				vim.log.levels.ERROR
			)
			return
		end
		M._server_instance = inst

		if type(M.config.hooks.on_start) == "function" then
			M.config.hooks.on_start(browser_url(inst.port))
		end

		if M.config.open_browser then
			vim.defer_fn(function()
				util.open_in_browser(browser_url(inst.port), M.config.browser)
			end, 200)
		end
	else
		-- Server already running in this nvim: retarget to this buffer's workspace
		pcall(ls_server.update_target, M._server_instance, dir, index_path)
		pcall(ls_server.reload, M._server_instance, M.config.content_name)

		if type(M.config.hooks.on_start) == "function" then
			M.config.hooks.on_start(browser_url(M._server_instance.port))
		end

		-- No browser tab connected (user closed it)? Re-open.
		if M.config.open_browser and ls_server.connected_client_count(M._server_instance) == 0 then
			vim.defer_fn(function()
				util.open_in_browser(browser_url(M._server_instance.port), M.config.browser)
			end, 200)
		end
	end

	-- Push an initial cursor position. The browser may not have its websocket
	-- open yet; the "hello" handshake (see on_browser_message) covers that case.
	vim.defer_fn(function() send_cursor_sync(bufnr, true) end, 500)
end


function M.refresh()
	local bufnr = vim.api.nvim_get_current_buf()
	local changed = maybe_refresh(bufnr, false)
	if not changed and M.config.notify_on_refresh then
		vim.notify("Markdown Preview: no changes detected", vim.log.levels.INFO)
	end
end


function M.stop()
	if M._augroup then
		pcall(vim.api.nvim_del_augroup_by_id, M._augroup)
		M._augroup = nil
	end
	if M._server_instance then
		pcall(ls_server.stop, M._server_instance)
		M._server_instance = nil
	end
	if M._follow_augroup then
		pcall(vim.api.nvim_del_augroup_by_id, M._follow_augroup)
		M._follow_augroup = nil
	end
	M._workspace_dir = nil
	M._last_cursor = nil
	M._token = nil

	if type(M.config.hooks.on_stop) == "function" then
		M.config.hooks.on_stop()
	end
end

return M
