// Background picker: list available room backgrounds and apply one.

import { state, markDirty } from "./state.js";
import { loadImage } from "./images.js";
import { assetUrl } from "./config.js";
import { api } from "./api.js";


let pickerBtn = null;
let popoverEl = null;
let listEl = null;
let renderRoom = null;        // function to redraw the canvas
let backgrounds = [];          // [{name, url}]


export async function initBackgrounds({ button, popover, list, onChange }) {
  pickerBtn = button;
  popoverEl = popover;
  listEl = list;
  renderRoom = onChange;

  pickerBtn.addEventListener("click", _togglePopover);
  document.addEventListener("click", _handleOutsideClick);

  await _fetchBackgrounds();
  _renderList();
  await _preloadCurrent();
}


async function _fetchBackgrounds() {
  try {
    const data = await api.backgrounds();
    backgrounds = data.items || [];
  } catch (err) {
    console.warn("Failed to fetch backgrounds", err);
    backgrounds = [];
  }
}


async function _preloadCurrent() {
  const url = state.room.background;
  if (!url) return;
  try {
    await loadImage(url);
    if (renderRoom) renderRoom();
  } catch (err) {
    console.warn("Background failed to load", url, err);
  }
}


function _renderList() {
  listEl.innerHTML = "";

  if (backgrounds.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted small";
    empty.textContent = "No backgrounds yet. Drop images into /backgrounds/.";
    listEl.appendChild(empty);
    return;
  }

  // "None" / clear option first.
  listEl.appendChild(_buildTile({ name: "None", url: null }, true));
  for (const bg of backgrounds) {
    listEl.appendChild(_buildTile(bg, false));
  }
}


function _buildTile(bg, isClear) {
  const tile = document.createElement("button");
  tile.className = "bg-tile";
  tile.title = bg.name;

  if (isClear) {
    tile.classList.add("bg-tile-clear");
    tile.textContent = "None";
  } else {
    const img = document.createElement("img");
    img.src = assetUrl(bg.url);
    img.alt = bg.name;
    tile.appendChild(img);
  }

  if ((state.room.background || null) === (bg.url || null)) {
    tile.classList.add("active");
  }

  tile.addEventListener("click", async (e) => {
    e.stopPropagation();
    await _setBackground(bg.url);
    _closePopover();
  });

  return tile;
}


async function _setBackground(url) {
  state.room.background = url;
  markDirty();
  if (url) {
    try { await loadImage(url); } catch (err) { console.warn(err); }
  }
  _renderList();
  if (renderRoom) renderRoom();
}


function _togglePopover(evt) {
  evt.stopPropagation();
  if (popoverEl.classList.contains("open")) _closePopover();
  else _openPopover();
}

function _openPopover() {
  popoverEl.classList.add("open");
}

function _closePopover() {
  popoverEl.classList.remove("open");
}

function _handleOutsideClick(e) {
  if (!popoverEl.classList.contains("open")) return;
  if (popoverEl.contains(e.target) || pickerBtn.contains(e.target)) return;
  _closePopover();
}
