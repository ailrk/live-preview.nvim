-- plugin/live-preview.lua
if vim.g.loaded_live_preview then
	return
end
vim.g.loaded_live_preview = true

-- User commands
vim.api.nvim_create_user_command("LivePreview", function()
	require("live_preview").start()
end, {})

vim.api.nvim_create_user_command("LivePreviewStop", function()
	require("live_preview").stop()
end, {})
