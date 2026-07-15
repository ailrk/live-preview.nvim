--------------------------------------------------------------------------
-- sha1.lua
--
-- Stripped-down SHA-1 implementation, adapted from HashLib
-- (originally by Egor Skriptunoff, ported to Roblox by boatbomber,
-- optimized by howmanysmall).
--
-- USAGE (from an nvim Lua config or plugin):
--     local sha1 = require("sha1")
--     local digest = sha1.sha1("hello world")   -- returns 40-char lowercase hex string
--
--     -- streaming/chunked usage:
--     local update = sha1.sha1()
--     update("hello ")
--     update("world")
--     local digest = update()
--
-- Only requires the LuaJIT `bit` library, which ships with Neovim.
------------------------------------------------------------------------

local bit = require("bit")

local band   = bit.band
local bor    = bit.bor
local bxor   = bit.bxor
local lshift = bit.lshift
local rol    = bit.rol
local ror    = bit.ror
local bnot   = bit.bnot

-- LuaJIT's bit ops operate on 32-bit signed integers and wrap around
-- automatically, so we don't need the "% 4294967296" masking that the
-- original Roblox (bit32, unsigned 0..2^32-1) version required.

local sha1_H = { 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0 }

local common_W = {}

local function sha1_feed_64(H, str, offs, size)
	-- offs >= 0, size >= 0, size is a multiple of 64
	local W = common_W
	local h1, h2, h3, h4, h5 = H[1], H[2], H[3], H[4], H[5]

	for pos = offs, offs + size - 1, 64 do
		for j = 1, 16 do
			pos = pos + 4
			local a, b, c, d = string.byte(str, pos - 3, pos)
			W[j] = bor(lshift(a, 24), lshift(b, 16), lshift(c, 8), d)
		end

		for j = 17, 80 do
			W[j] = rol(bxor(W[j - 3], W[j - 8], W[j - 14], W[j - 16]), 1)
		end

		local a, b, c, d, e = h1, h2, h3, h4, h5

		for j = 1, 20 do
			local z = rol(a, 5) + bor(band(b, c), band(bnot(b), d)) + 0x5A827999 + W[j] + e
			e, d, c, b, a = d, c, ror(b, 2), a, z
		end

		for j = 21, 40 do
			local z = rol(a, 5) + bxor(b, c, d) + 0x6ED9EBA1 + W[j] + e
			e, d, c, b, a = d, c, ror(b, 2), a, z
		end

		for j = 41, 60 do
			local z = rol(a, 5) + bor(band(d, c), band(b, bxor(d, c))) + 0x8F1BBCDC + W[j] + e
			e, d, c, b, a = d, c, ror(b, 2), a, z
		end

		for j = 61, 80 do
			local z = rol(a, 5) + bxor(b, c, d) + 0xCA62C1D6 + W[j] + e
			e, d, c, b, a = d, c, ror(b, 2), a, z
		end

		h1 = h1 + a
		h2 = h2 + b
		h3 = h3 + c
		h4 = h4 + d
		h5 = h5 + e
	end

	H[1], H[2], H[3], H[4], H[5] = h1, h2, h3, h4, h5
end

local function sha1(message)
	-- Create an instance (private state for this calculation)
	local H = { sha1_H[1], sha1_H[2], sha1_H[3], sha1_H[4], sha1_H[5] }
	local length, tail = 0, ""

	local function partial(message_part)
		if message_part then
			local partLength = #message_part
			if tail then
				length = length + partLength
				local offs = 0
				if tail ~= "" and #tail + partLength >= 64 then
					offs = 64 - #tail
					sha1_feed_64(H, tail .. string.sub(message_part, 1, offs), 0, 64)
					tail = ""
				end

				local size = partLength - offs
				local size_tail = size % 64
				sha1_feed_64(H, message_part, offs, size - size_tail)
				tail = tail .. string.sub(message_part, partLength + 1 - size_tail)
				return partial
			else
				error("Adding more chunks is not allowed after receiving the result", 2)
			end
		else
			if tail then
				local final_blocks = {
					tail,
					"\128",
					string.rep("\0", (-9 - length) % 64 + 1),
				}
				tail = nil

				-- Append the bit-length of the message, big-endian.
				-- The padding math above reserves 7 bytes here (the
				-- implicit high byte of the 8-byte SHA-1 length field is
				-- always 0 for messages under 2^53 bytes, which covers
				-- any realistic input), matching (-9-length)%64+1 above.
				local bitlen = length * 8
				local lenbytes = {}
				for i = 7, 1, -1 do
					lenbytes[i] = string.char(bitlen % 256)
					bitlen = math.floor(bitlen / 256)
				end
				final_blocks[4] = table.concat(lenbytes)

				final_blocks = table.concat(final_blocks)
				sha1_feed_64(H, final_blocks, 0, #final_blocks)

				for j = 1, 5 do
					-- LuaJIT's bit ops yield signed 32-bit ints; string.format("%x", ...)
					-- sign-extends negative numbers to 64 bits, so convert to the
					-- unsigned 0..2^32-1 range via arithmetic first.
					H[j] = string.format("%08x", H[j] % 4294967296)
				end

				H = table.concat(H)
			end

			return H
		end
	end

	if message then
		-- One-shot usage: sha1.sha1("some string") -> hex digest
		return partial(message)()
	else
		-- Chunked usage: local update = sha1.sha1(); update(part1); update(part2); update()
		return partial
	end
end


return {
	sha1 = sha1,
}
