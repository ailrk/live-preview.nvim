# live-preview.nvim

[demo](https://github.com/user-attachments/assets/669ce216-2e8f-47ae-a279-3187b282cb9a)

Markdown preview in the browser, updated as you type.

- Live reload
- Bidirecitonal cursor sync
- Follows the markdown buffer you switch to
- Mermaid diagrams
- KaTeX
- Relative images
- YAML front matter panel
- Stand alone plugin, no extra dependencies
- One server per Neovim instance on a free port

## Install
```lua
{
  "ailrk/live-preview.nvim",
  dependencies = { "you/live-server.nvim" },
  cmd = { "LivePreview", "LivePreviewStop" },
  opts = {},
}
```

## Commands

| Command            | Description                       |
| ------------------ | --------------------------------- |
| `:LivePreview`     | Start (or restart) the preview    |
| `:LivePreviewStop` | Stop the server                   |

In `.mmd` / `.mermaid` files the whole buffer is rendered. In other filetypes
the mermaid block under the cursor is.

## Options

Defaults shown for the common ones:

```lua
{
  host = "127.0.0.1",        -- "0.0.0.0" for network access
  open_browser = true,
  browser = nil,             -- app name, or a command table
  default_theme = "light",   -- "light" | "dark"
  cursor_sync = true,        -- cursor sync, both directions
  allow_raw_html = true,     -- false for untrusted markdown
  yaml_mode = "panel",       -- "panel" | "hide" | "raw"
  custom_css = "",           -- path to a CSS file
  extra_asset_roots = {},    -- extra dirs images may be served from
  debounce_ms = 300,         -- debounce interval
  bottom_padding = 0.5,      -- 0.5 = middle of viewport, 1.0 = bottom edge
}
```

See `lua/live_preview/init.lua` for the full list.
