'use client';

import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect } from 'react';
import { createClient } from './client';
import { SupabaseClient } from '@supabase/supabase-js';

const Context = createContext<SupabaseClient | null>(null);

export default function SupabaseProvider({
  children
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    if (!supabase) return;

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') router.refresh();
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [router, supabase]);

  return <Context.Provider value={supabase}>{children}</Context.Provider>;
}

export const useSupabase = () => {
  const context = useContext(Context);
  return context;
};

export const useSupabaseRequired = () => {
  const context = useContext(Context);

  if (context === null) {
    throw new Error('Supabase is not configured. Please set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables.');
  }

  return context;
};