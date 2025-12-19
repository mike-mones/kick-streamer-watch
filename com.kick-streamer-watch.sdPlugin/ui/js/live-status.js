(() => {
  let websocket = null;
  let context = "";
  let currentSettings = {};
  let maxStreamers = 99; // Default limit

  const streamerList = document.getElementById("streamer-list");
  const addStreamerBtn = document.getElementById("add-streamer");
  // const saveBtn = document.getElementById("save-button"); // Removed
  const loginBtn = document.getElementById("login-button");
  const logoutBtn = document.getElementById("logout-button");

  addStreamerBtn.addEventListener("click", () => {
      addStreamerInput("");
      checkLimit();
  });
  
  // saveBtn.addEventListener("click", sendSettings); // Removed
  loginBtn.addEventListener("click", () => sendPluginAction("login"));
  logoutBtn.addEventListener("click", () => sendPluginAction("logout"));

  let debounceTimer;
  function debouncedSave() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
          sendSettings();
      }, 500); // Wait 500ms after last input
  }

  function addStreamerInput(value) {
    const div = document.createElement("div");
    div.className = "input-group";

    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.placeholder = "Streamer Username";
    
    // Auto-save on input with debounce
    input.addEventListener("input", (e) => {
        debouncedSave();
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "×"; // or use an icon
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", () => {
        div.remove();
        checkLimit();
        debouncedSave(); // Save immediately on remove
    });

    div.appendChild(input);
    
    // Always allow removing, unless we want to enforce at least 1? 
    // For now, allow removing all.
    div.appendChild(removeBtn);
    
    streamerList.appendChild(div);
  }

  function checkLimit() {
      const inputCount = streamerList.querySelectorAll(".input-group").length;
      if (inputCount >= maxStreamers) {
          addStreamerBtn.style.display = "none";
      } else {
          addStreamerBtn.style.display = "inline-block";
      }
  }

  window.connectElgatoStreamDeckSocket = function (port, uuid, registerEvent, _info, _actionInfo) {
    context = uuid;
    websocket = new WebSocket(`ws://127.0.0.1:${port}`);

    // Parse actionInfo to determine which action we are configuring
    let actionId = "";
    try {
        const infoObj = typeof _actionInfo === "string" ? JSON.parse(_actionInfo) : _actionInfo;
        actionId = infoObj.action;
    } catch (e) {
        console.error("Failed to parse actionInfo", e);
    }

    // Set limits based on action
    if (actionId === "com.kick-streamer-watch.live-status") {
        maxStreamers = 4;
    } else if (actionId === "com.kick-streamer-watch.multi-status") {
        maxStreamers = 4;
    }

    websocket.addEventListener("open", () => {
      websocket.send(JSON.stringify({ event: registerEvent, uuid: context }));
      requestSettings();
    });

    websocket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.event === "didReceiveSettings") {
        currentSettings = message.payload.settings;
        updateUI(currentSettings);
      }
    });
  };

  function requestSettings() {
    if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
    websocket.send(JSON.stringify({ event: "getSettings", context }));
  }

  function updateUI(settings) {
    streamerList.innerHTML = ""; // Clear existing
    const channels = (settings.channel || "").split(",").map(c => c.trim()).filter(c => c);
    
    if (channels.length === 0) {
        addStreamerInput(""); // Add one empty input if none
    } else {
        channels.forEach(channel => addStreamerInput(channel));
    }
    
    checkLimit();
  }

  function sendSettings() {
    if (!websocket || websocket.readyState !== WebSocket.OPEN) return;

    const inputs = streamerList.querySelectorAll("input[type='text']");
    const channels = Array.from(inputs)
        .map(input => input.value.trim())
        .filter(val => val.length > 0);
    
    const channelString = channels.join(",");

    websocket.send(JSON.stringify({
      event: "setSettings",
      context,
      payload: { channel: channelString },
    }));
  }

  function sendPluginAction(action) {
    if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
    websocket.send(JSON.stringify({
      event: "sendToPlugin",
      context,
      payload: { action }
    }));
  }
})();
