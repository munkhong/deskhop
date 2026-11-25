const mgmtReportId = 6;
var device;

const packetType = {
  keyboardReportMsg: 1, mouseReportMsg: 2, outputSelectMsg: 3, firmwareUpgradeMsg: 4, switchLockMsg: 7,
  syncBordersMsg: 8, flashLedMsg: 9, wipeConfigMsg: 10, readConfigMsg: 16, writeConfigMsg: 17, saveConfigMsg: 18,
  rebootMsg: 19, getValMsg: 20, setValMsg: 21, getValAllMsg: 22, proxyPacketMsg: 23
};

function calcChecksum(report) {
  let checksum = 0;
  for (let i = 3; i < 11; i++)
    checksum ^= report[i];

  return checksum;
}

async function sendReport(type, payload = [], sendBoth = false) {
  if (!device || !device.opened)
    return;

  /* First send this one, if the first one gets e.g. rebooted */
  if (sendBoth) {
    var reportProxy = makeReport(type, payload, true);
    await device.sendReport(mgmtReportId, reportProxy);
    }

    var report = makeReport(type, payload, false);
    await device.sendReport(mgmtReportId, report);
}

function makeReport(type, payload, proxy=false) {
  var dataOffset = proxy ? 4 : 3;
  report = new Uint8Array([0xaa, 0x55, type, ...new Array(9).fill(0)]);

  if (proxy)
    report = new Uint8Array([0xaa, 0x55, packetType.proxyPacketMsg, type, ...new Array(7).fill(0), type]);

  if (payload) {
    report.set([...payload], dataOffset);
    report[report.length - 1] = calcChecksum(report);
  }
  return report;
}

/* How many of the units the device stores go into one of the units the form shows, so
   a field can be presented in something a person thinks in and still be sent as what the
   firmware expects. Set from form.py; 1 for everything that needs no conversion. */
function scaleOf(element) {
  return Number(element.getAttribute('data-scale')) || 1;
}

function packValue(element, key, dataType, buffer) {
  const dataOffset = 1;
  var buffer = new ArrayBuffer(8);
  var view = new DataView(buffer);

  const methods = {
    "uint32": view.setUint32,
    "uint64": view.setUint32, /* Yes, I know. :-| */
    "int32": view.setInt32,
    "uint16": view.setUint16,
    "uint8": view.setUint8,
    "int16": view.setInt16,
    "int8": view.setInt8
  };

  if (dataType in methods) {
    const method = methods[dataType];
    if (element.type === 'checkbox')
      view.setUint8(dataOffset, element.checked ? 1 : 0, true);
    else
      method.call(view, dataOffset, element.value * scaleOf(element), true);
  }

  view.setUint8(0, key);
  return new Uint8Array(buffer);
}

window.addEventListener('load', function () {
  if (!("hid" in navigator)) {
    document.getElementById('warning').style.display = 'block';
  }

  autoConnect();

  this.document.getElementById('menu-buttons').addEventListener('click', function (event) {
    const handler = event.target.closest('[data-handler]');
    if (handler)
      runAction(handler.dataset.handler);
  })
});

document.getElementById('submitButton').addEventListener('click', () => runAction('saveHandler'));

const deskhopFilter = { vendorId: 0x2e8a, productId: 0x107c, usagePage: 0xff00, usage: 0x10 };

function isDeskhop(d) {
  return d.vendorId === deskhopFilter.vendorId && d.productId === deskhopFilter.productId &&
    d.collections.some(c => c.usagePage === deskhopFilter.usagePage && c.usage === deskhopFilter.usage);
}

async function openDevice(d) {
  if (!d || (device && device.opened))
    return;

  device = d;
  if (!device.opened)
    await device.open();

  device.addEventListener('inputreport', handleInputReport);
  document.querySelectorAll('.online').forEach(element => { element.style.opacity = 1.0; });
  await readHandler('Connected · settings loaded');
}

async function connectHandler() {
  if (device && device.opened)
    return;

  var devices = await navigator.hid.requestDevice({ filters: [deskhopFilter] });
  if (!devices.length) {
    toast('No device selected', 'warn');
    return;
  }
  await openDevice(devices[0]);
}

/* Chrome remembers a device once you've allowed it, so reconnect without a click when we can:
   on page load, and whenever the DeskHop shows up again (e.g. after re-entering config mode). */
async function autoConnect() {
  if (!("hid" in navigator))
    return;

  const known = (await navigator.hid.getDevices()).find(isDeskhop);
  if (known)
    await openDevice(known);

  navigator.hid.addEventListener('connect', async (event) => {
    if (isDeskhop(event.device))
      await openDevice(event.device);
  });

  navigator.hid.addEventListener('disconnect', (event) => {
    if (device && event.device === device) {
      device = undefined;
      document.querySelectorAll('.online').forEach(element => { element.style.opacity = ''; });
      toast('Device disconnected', 'warn');
    }
  });
}

async function blinkHandler() {
  await sendReport(packetType.flashLedMsg, []);
}

async function blinkBothHandler() {
  await sendReport(packetType.flashLedMsg, [], true);
}

function getValue(element) {
  if (element.type === 'checkbox')
    return element.checked ? 1 : 0;
  else
    return element.value;
}

function setValue(element, value) {
  element.setAttribute('fetched-value', value);

  if (element.type === 'checkbox')
    element.checked = value;
  else
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
}


function updateElement(key, event) {
  var dataOffset = 4;
  var element = document.querySelector(`[data-key="${key}"]`);

  if (!element)
    return;

  const methods = {
    "uint32": event.data.getUint32,
    "uint64": event.data.getUint32, /* Yes, I know. :-| */
    "int32": event.data.getInt32,
    "uint16": event.data.getUint16,
    "uint8": event.data.getUint8,
    "int16": event.data.getInt16,
    "int8": event.data.getInt8
  };

  dataType = element.getAttribute('data-type');

  if (dataType in methods) {
    var value = methods[dataType].call(event.data, dataOffset, true) / scaleOf(element);
    setValue(element, value);

    if (element.hasAttribute('data-hex'))
      setValue(element, parseInt(value).toString(16));

    if (element.hasAttribute('data-fw-ver')) {
      /* u16 version = major * 1000 + minor + 100; */
      const major = Math.floor((value - 100) / 1000);
      const minor = (value - 100) % 1000;
      setValue(element, `v${major}.${minor}`);
    }
  }
}

/* Tracks a Read in progress so we can tell the user once values arrive (or don't) */
var pendingRead = null;

async function readHandler(successText = 'Settings loaded') {
  if (!device || !device.opened)
    await connectHandler();

  if (pendingRead) {
    clearTimeout(pendingRead.done);
    clearTimeout(pendingRead.timeout);
  }

  pendingRead = { count: 0, successText };
  pendingRead.timeout = setTimeout(() => {
    if (pendingRead && pendingRead.count === 0)
      toast('No response from device', 'error');
    pendingRead = null;
  }, 2000);

  await sendReport(packetType.getValAllMsg);
}

async function handleInputReport(event) {
  var data = new Uint8Array(event.data.buffer);
  var key = data[3];

  updateElement(key, event);

  /* Values arrive one report each; call it done once they stop coming */
  if (pendingRead) {
    pendingRead.count++;
    clearTimeout(pendingRead.done);
    pendingRead.done = setTimeout(() => {
      clearTimeout(pendingRead.timeout);
      toast(pendingRead.successText, 'success');
      pendingRead = null;
    }, 300);
  }
}

async function rebootHandler() {
  await sendReport(packetType.rebootMsg);
}

async function enterBootloaderHandler() {
  await sendReport(packetType.firmwareUpgradeMsg, true, true);
}

async function valueChangedHandler(element) {
  var key = element.getAttribute('data-key');
  var dataType = element.getAttribute('data-type');

  var origValue = element.getAttribute('fetched-value');
  var newValue = getValue(element);

  if (origValue != newValue) {
    uintBuffer = packValue(element, key, dataType);

    /* Send to both devices */
    await sendReport(packetType.setValMsg, uintBuffer, true);

    /* Set this as the current value */
    element.setAttribute('fetched-value', newValue);
  }
}

async function saveHandler() {
  const elements = document.querySelectorAll('.api');

  if (!device || !device.opened)
    return;

  for (const element of elements) {
    var origValue = element.getAttribute('fetched-value')

    if (element.hasAttribute('readonly'))
      continue;

    if (origValue != getValue(element))
      await valueChangedHandler(element);
  }
  await sendReport(packetType.saveConfigMsg, [], true);
}

async function wipeConfigHandler() {
  await sendReport(packetType.wipeConfigMsg, [], true);
}

/* Swap the monitor layout between outputs A and B, same fields as the Left Ctrl + Right Shift + W
   hotkey: screen count, speed X/Y, border top/bottom, screen position and cursor park position.
   OS and screensaver stay with their output. Each changed value is sent to both boards, then saved. */
const swapFieldOffsets = [1, 2, 3, 4, 5, 7, 8];
const outputBase = { A: 10, B: 40 };

async function swapLayoutHandler() {
  if (!device || !device.opened)
    return;

  const changed = [];

  for (const offset of swapFieldOffsets) {
    const a = document.querySelector(`.api[data-key="${outputBase.A + offset}"]`);
    const b = document.querySelector(`.api[data-key="${outputBase.B + offset}"]`);

    if (!a || !b)
      continue;

    const valueA = a.value;
    a.value = b.value;
    b.value = valueA;

    /* Keep the number boxes next to the sliders in step */
    a.dispatchEvent(new Event('input', { bubbles: true }));
    b.dispatchEvent(new Event('input', { bubbles: true }));

    changed.push(a, b);
  }

  for (const element of changed)
    await valueChangedHandler(element);

  await sendReport(packetType.saveConfigMsg, [], true);
}

/* ---------- Feedback toasts ---------- */

function toast(text, kind = 'info', ms = 3500) {
  let stack = document.getElementById('toasts');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toasts';
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }

  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = text;
  el.addEventListener('click', () => el.remove());
  stack.appendChild(el);

  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

/* What to say after each action. Read reports for itself once values arrive. */
const actionMessages = {
  saveHandler:            ['Saved to both boards', 'Save failed'],
  swapLayoutHandler:      ['Swapped A ⇄ B and saved', 'Swap failed'],
  rebootHandler:          ['Leaving config mode…', 'Exit failed'],
  blinkHandler:           ['Blink sent', 'Blink failed'],
  blinkBothHandler:       ['Blink sent to both boards', 'Blink failed'],
  enterBootloaderHandler: ['Bootloader mode requested', 'Bootloader request failed'],
  wipeConfigHandler:      ['Config wiped · defaults restored', 'Wipe failed'],
};

async function runAction(name) {
  const needsDevice = name !== 'connectHandler';

  if (needsDevice && (!device || !device.opened)) {
    toast('Not connected · click Connect first', 'warn');
    return;
  }

  try {
    await window[name]();

    if (actionMessages[name])
      toast(actionMessages[name][0], 'success');
  } catch (err) {
    const failText = actionMessages[name] ? actionMessages[name][1] : 'Could not connect';
    toast(`${failText}: ${err.message || err}`, 'error', 6000);
  }
}
