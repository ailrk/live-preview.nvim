# live-preview.nvim

[demo2](https://github.com/user-attachments/assets/c57f796a-6427-48d9-b1f7-0dfee58c7027)

Markdown preview in the browser, update as you type, follows your cursor.

- Live reload
- Bidirecitonal cursor sync
- Follows the markdown buffer you switch to
- Mermaid diagrams
- KaTeX
- Relative images
- YAML frontmatter panel
- Stand alone plugin, no extra dependencies
- One server per Neovim instance on a free port

![demo1](https://github.com/user-attachments/assets/2523fa84-f8d5-4fdd-bdbd-000c7d268c9a)

![demo3](https://github.com/user-attachments/assets/a14512f1-44c2-4b3e-b540-519c5073ef76)

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
  default_theme = "light",   -- "light" | "dark"
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

## Alternatives

You can find similar live preview plugins here:

- [iamcco/markdown-preview.nvim](https://github.com/iamcco/markdown-preview.nvim)
- [brianhuster/live-preview.nvim](https://github.com/brianhuster/live-preview.nvim)
- [selimacerbas/mdkite.nvim](https://github.com/selimacerbas/mdkite.nvim)
- [mhersson/mpls](https://github.com/mhersson/mpls)
