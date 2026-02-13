export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          created_at: string
          entity: string
          entity_id: string | null
          id: string
          meta: Json | null
          store_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          entity: string
          entity_id?: string | null
          id?: string
          meta?: Json | null
          store_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          entity?: string
          entity_id?: string | null
          id?: string
          meta?: Json | null
          store_id?: string | null
        }
        Relationships: []
      }
      captive_sessions: {
        Row: {
          ap_mac: string | null
          authorized_at: string | null
          client_ip: string | null
          client_mac: string | null
          fail_reason: string | null
          id: string
          redirect_url: string | null
          ssid: string | null
          started_at: string
          status: Database["public"]["Enums"]["session_status"]
          store_id: string
          submitted_at: string | null
          user_agent: string | null
        }
        Insert: {
          ap_mac?: string | null
          authorized_at?: string | null
          client_ip?: string | null
          client_mac?: string | null
          fail_reason?: string | null
          id?: string
          redirect_url?: string | null
          ssid?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["session_status"]
          store_id: string
          submitted_at?: string | null
          user_agent?: string | null
        }
        Update: {
          ap_mac?: string | null
          authorized_at?: string | null
          client_ip?: string | null
          client_mac?: string | null
          fail_reason?: string | null
          id?: string
          redirect_url?: string | null
          ssid?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["session_status"]
          store_id?: string
          submitted_at?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "captive_sessions_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "captive_sessions_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores_public"
            referencedColumns: ["id"]
          },
        ]
      }
      consent_versions: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          text: string
          version: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          text: string
          version: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          text?: string
          version?: string
        }
        Relationships: []
      }
      leads: {
        Row: {
          client_mac: string | null
          consent_text_hash: string | null
          consent_version: string
          consented_at: string
          created_at: string
          email: string | null
          id: string
          name: string
          phone: string | null
          session_id: string | null
          source: string
          store_id: string
        }
        Insert: {
          client_mac?: string | null
          consent_text_hash?: string | null
          consent_version: string
          consented_at: string
          created_at?: string
          email?: string | null
          id?: string
          name: string
          phone?: string | null
          session_id?: string | null
          source?: string
          store_id: string
        }
        Update: {
          client_mac?: string | null
          consent_text_hash?: string | null
          consent_version?: string
          consented_at?: string
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          phone?: string | null
          session_id?: string | null
          source?: string
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "leads_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "captive_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores_public"
            referencedColumns: ["id"]
          },
        ]
      }
      stores: {
        Row: {
          city: string | null
          created_at: string
          id: string
          is_active: boolean
          name: string
          slug: string
          unifi_api_key_or_token: string | null
          unifi_controller_url: string | null
          unifi_site_id: string | null
          updated_at: string
        }
        Insert: {
          city?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          slug: string
          unifi_api_key_or_token?: string | null
          unifi_controller_url?: string | null
          unifi_site_id?: string | null
          updated_at?: string
        }
        Update: {
          city?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          slug?: string
          unifi_api_key_or_token?: string | null
          unifi_controller_url?: string | null
          unifi_site_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      stores_public: {
        Row: {
          city: string | null
          id: string | null
          is_active: boolean | null
          name: string | null
          slug: string | null
        }
        Insert: {
          city?: string | null
          id?: string | null
          is_active?: boolean | null
          name?: string | null
          slug?: string | null
        }
        Update: {
          city?: string | null
          id?: string | null
          is_active?: boolean | null
          name?: string | null
          slug?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      normalize_mac: { Args: { mac: string }; Returns: string }
    }
    Enums: {
      app_role: "admin"
      session_status: "started" | "submitted" | "authorized" | "failed"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin"],
      session_status: ["started", "submitted", "authorized", "failed"],
    },
  },
} as const
