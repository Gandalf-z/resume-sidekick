'use strict';

async function enableSidePanelOnClick() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    // Side panel behavior is optional on older Chrome builds.
    console.warn('Unable to enable side panel click behavior:', error);
  }
}

chrome.runtime.onInstalled.addListener(enableSidePanelOnClick);
chrome.runtime.onStartup.addListener(enableSidePanelOnClick);
enableSidePanelOnClick();