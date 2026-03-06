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
  });

  const showVideoOptionsSheet = useCallback((video, isOwner, hasDownloaded, callbacks) => {
    setSheetState({
      visible: true,
      video,
      isOwner,
      hasDownloaded,
      onPin: callbacks.onPin,
      onDelete: callbacks.onDelete,
      onDownload: callbacks.onDownload,
    });
  }, []);

  const hideVideoOptionsSheet = useCallback(() => {
    setSheetState(prev => ({ ...prev, visible: false }));
  }, []);

  return (
    <DownloadContext.Provider value={{ 
      sheetState, 
      showVideoOptionsSheet, 
      hideVideoOptionsSheet 
    }}>
      {children}
    </DownloadContext.Provider>
  );
}

export function useDownload() {
  return useContext(DownloadContext);
}

export default DownloadContext;