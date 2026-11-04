-- lua/live_preview/util.lua
local M = {}

-- Generate a per-buffer workspace directory under Neovim's cache.
---@param bufnr integer
---@return string
function M.workspace_for_buffer(bufnr)
	local name = vim.api.nvim_buf_get_name(bufnr)
	local hash = vim.fn.sha256(name):sub(1, 12)
	return vim.fs.joinpath(vim.fn.stdpath("cache"), "live-preview", hash)
end

M.shared_workspace = (function()
    -- a static variable
    local cached_path = nil

    return function()
        if not cached_path then
            cached_path = vim.fs.joinpath(vim.fn.stdpath("cache"), "live-preview", "shared")
            vim.fn.mkdir(cached_path, "p")
        end
        return cached_path
    end
end)()

-- Launch a detached command; true when the process spawned.
-- (vim.fn.jobstart raises for a non-executable command, so pcall it.)
local function try_launch(cmd, opts)
	local ok, job = pcall(vim.fn.jobstart, cmd, opts or { detach = true })
	return ok and job > 0
end

-- Open a URL in the browser.
---@param url string
function M.open_in_browser(url)
	local candidates
	if vim.fn.has("mac") == 1 then
		candidates = { { "open", url } }
	elseif vim.fn.has("wsl") == 1 then
		candidates = { { "cmd.exe", "/c", "start", url } }
	elseif vim.fn.has("unix") == 1 then
		candidates = { { "xdg-open", url } }
	elseif vim.fn.has("win32") == 1 then
		candidates = { { "cmd.exe", "/c", "start", url } }
	else
		candidates = {}
	end

	for _, cmd in ipairs(candidates) do
		if vim.fn.executable(cmd[1]) == 1 and try_launch(cmd) then
			return
		end
	end
	vim.notify("Live Preview: could not open a browser automatically", vim.log.levels.WARN)
end

return M
