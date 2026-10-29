local M = {}

local sep = package.config:sub(1, 1)

local function dirname(path)
	return path:match("^(.*" .. sep .. ")") or "./"
end

function M.mkdirp(path)
	if vim.fn.isdirectory(path) == 0 then
		vim.fn.mkdir(path, "p")
	end
end

function M.file_exists(path)
	if not path then
		return false
	end
	local stat = vim.loop.fs_stat(path)
	return stat and stat.type == "file"
end

function M.write_text(path, text)
	M.mkdirp(dirname(path))
	local fd = assert(vim.loop.fs_open(path, "w", 420)) -- 0644
	assert(vim.loop.fs_write(fd, text, 0))
	assert(vim.loop.fs_close(fd))
end

function M.read_text(path)
	assert(type(path) == "string" and #path > 0, "read_text: path is nil")
	local fd = assert(vim.loop.fs_open(path, "r", 420))
	local stat = assert(vim.loop.fs_fstat(fd))
	local data = assert(vim.loop.fs_read(fd, stat.size, 0))
	assert(vim.loop.fs_close(fd))
	return data
end

function M.copy_file(src, dst)
	assert(type(src) == "string" and #src > 0, "copy_file: source path is nil")
	local data = M.read_text(src)
	M.write_text(dst, data)
end

---Resolve a file shipped with the plugin using runtimepath first.
function M.resolve_asset(rel)
	local sep = sep
    local hits = vim.api.nvim_get_runtime_file(rel, false)
    if hits and #hits > 0 then
        return hits[1]
    end
	return nil
end

return M
