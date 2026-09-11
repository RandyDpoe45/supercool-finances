import { configureStore } from '@reduxjs/toolkit';
import { setupListeners } from '@reduxjs/toolkit/query';
import { analyticsApi } from '../services/api/analyticsApi';
import { baseApi } from '../services/api/baseApi';

// TWO RTK Query slices are registered side by side: `baseApi` (balance-service `/balance/admin`)
// and `analyticsApi` (analytics server `/analytics/admin`). Each contributes its own reducer AND
// its own middleware — omitting the middleware would silently break that slice's caching/refetch.
export const store = configureStore({
  reducer: {
    [baseApi.reducerPath]: baseApi.reducer,
    [analyticsApi.reducerPath]: analyticsApi.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(baseApi.middleware).concat(analyticsApi.middleware),
});

// Enables RTK Query's refetchOnFocus / refetchOnReconnect behaviour when opted in.
setupListeners(store.dispatch);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
