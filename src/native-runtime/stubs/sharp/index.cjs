// @huggingface/transformers requires sharp to be present when it loads, but calls it only to read images.
// Prism embeds text only, so this stand-in loads and refuses any image work.
module.exports = function sharp() {
  throw new Error("Image processing is not available in Prism's native runtime.");
};
