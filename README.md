# live-preview.nvim

[demo](https://github.com/user-attachments/assets/c57f796a-6427-48d9-b1f7-0dfee58c7027)

Markdown preview in the browser, updated as you type.

- Live reload
- Bidirecitonal cursor sync
- Follows the markdown buffer you switch to
- Mermaid diagrams
- KaTeX
- Relative images
- YAML frontmatter panel
- Stand alone plugin, no extra dependencies
- One server per Neovim instance on a free port

## Install

With Lazy.nvim:

```lua
{
  "ailrk/live-preview.nvim",
  cmd = { "LivePreview", "LivePreviewStop" },
  config = function ()
    require("live_preview").setup{}
  end
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
  debounce_ms = 100,         -- debounce interval
  bottom_padding = 0.5,      -- 0.5 = middle of viewport, 1.0 = bottom edge
}
```

See `lua/live_preview/init.lua` for the full list.

## Offline

You need Internet access the first time using this plugin so the frontend
can load CDN packages for markdown. After the first run packages are cached by
the server, stored at `~/.cache/nvim` (not in the browser). You can use it
offline afterwards as long as you don't clear your cache.
