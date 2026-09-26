import React, { createContext, useContext, useState, useCallback } from 'react';

const DownloadContext = createContext();

export function DownloadProvider({ children }) {
  const [sheetState, setSheetState] = useState({
    visible: false,
    video: null,
    isOwner: false,
    hasDownloaded: false,
    onPin: null,
    onDelete: null,
    onDownload: null,
    onBlock: null,
  });

  const showVideoOptionsSheet = useCallback((video, isOwner, hasDownloaded, callbacks, currentUserId, navigation) => {
    setSheetState({
      visible: true,
      video,
      isOwner,
      hasDownloaded,
      currentUserId,
      navigation,
      onPin: callbacks.onPin,
      onDelete: callbacks.onDelete,
      onDownload: callbacks.onDownload,
      onBlock: callbacks.onBlock,
    });
  }, []);

  const hideVideoOptionsSheet = useCallback(() => {
    setSheetState(prev => ({ ...prev, visible: false }));
  }, []);

  const showTikTokShare = useCallback((video, currentUserId, navigation) => {
    // (removed for production)
    setSheetState({
      visible: false,
      video,
      isOwner: false,
      hasDownloaded: false,
      currentUserId,
      navigation: navigation || null,
      onPin: null,
      onDelete: null,
      onDownload: null,
      onBlock: null,
      tiktokShareVisible: true,
    });
  }, []);

  const hideTikTokShare = useCallback(() => {
    setSheetState(prev => ({ ...prev, tiktokShareVisible: false }));
  }, []);

  return (
    <DownloadContext.Provider value={{ 
      sheetState, 
      showVideoOptionsSheet, 
      hideVideoOptionsSheet,
      showTikTokShare,
      hideTikTokShare,
    }}>
      {children}
    </DownloadContext.Provider>
  );
}

export function useDownload() {
  return useContext(DownloadContext);
}

export default DownloadContext;