import { Component, ChangeDetectionStrategy, inject, OnInit, signal, computed } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { BrainSocketService } from "../../services/brain-socket.service";
import type { IDatabaseInfo, IQueryDatabaseResult } from "../../models/brain.types";

@Component({
  selector: "app-database",
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: "./database.html",
  styleUrl: "./database.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DatabaseComponent implements OnInit {
  //#region Data members

  private _socket = inject(BrainSocketService);

  //#endregion Data members

  //#region Public members

  protected readonly connected = this._socket.connected;

  protected databases = signal<IDatabaseInfo[]>([]);
  protected tables = signal<string[]>([]);
  protected rows = signal<Record<string, unknown>[]>([]);
  protected columns = signal<string[]>([]);

  protected selectedDatabase = signal<string | null>(null);
  protected selectedTable = signal<string | null>(null);

  protected whereClause = signal("");
  protected orderByClause = signal("");
  protected limitValue = signal(100);

  protected isLoading = signal(false);
  protected error = signal<string | null>(null);
  protected totalCount = signal(0);
  protected returnedCount = signal(0);

  protected readonly hasData = computed((): boolean => {
    return this.rows().length > 0;
  });

  protected readonly columnList = computed((): string[] => {
    const rows = this.rows();
    if (rows.length === 0) return this.columns();

    const allKeys = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach((key) => allKeys.add(key));
    }
    return Array.from(allKeys);
  });

  //#endregion Public members

  //#region Constructor

  public ngOnInit(): void {
    this._loadDatabasesAsync();
  }

  //#endregion Constructor

  //#region Public methods

  protected async onRefreshAsync(): Promise<void> {
    await this._loadDatabasesAsync();
  }

  protected async onSelectDatabaseAsync(dbName: string): Promise<void> {
    this.selectedDatabase.set(dbName);
    this.selectedTable.set(null);
    this.tables.set([]);
    this.rows.set([]);
    this.columns.set([]);
    this.totalCount.set(0);
    this.returnedCount.set(0);
    this.error.set(null);

    if (dbName) {
      await this._loadTablesAsync(dbName);
    }
  }

  protected async onSelectTableAsync(tableName: string): Promise<void> {
    this.selectedTable.set(tableName);
    this.rows.set([]);
    this.columns.set([]);
    this.totalCount.set(0);
    this.returnedCount.set(0);
    this.error.set(null);

    if (tableName) {
      await this._queryTableAsync();
    }
  }

  protected async onQueryAsync(): Promise<void> {
    if (!this.selectedDatabase() || !this.selectedTable()) {
      return;
    }

    await this._queryTableAsync();
  }

  protected formatValue(value: unknown): string {
    if (value === null) return "NULL";
    if (value === undefined) return "";
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  protected formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  //#endregion Public methods

  //#region Private methods

  private async _loadDatabasesAsync(): Promise<void> {
    this.isLoading.set(true);
    this.error.set(null);

    try {
      const result: IQueryDatabaseResult = await this._socket.queryDatabaseAsync("list_databases");

      if (result.success && result.databases) {
        this.databases.set(result.databases);
      } else {
        this.error.set(result.error ?? "Failed to load databases");
        this.databases.set([]);
      }
    } catch (err: unknown) {
      const errorMessage: string = err instanceof Error ? err.message : String(err);
      this.error.set(errorMessage);
      this.databases.set([]);
    } finally {
      this.isLoading.set(false);
    }
  }

  private async _loadTablesAsync(databaseName: string): Promise<void> {
    this.isLoading.set(true);
    this.error.set(null);

    try {
      const result: IQueryDatabaseResult = await this._socket.queryDatabaseAsync(
        "list_tables",
        databaseName,
      );

      if (result.success && result.tables) {
        this.tables.set(result.tables);
      } else {
        this.error.set(result.error ?? "Failed to load tables");
        this.tables.set([]);
      }
    } catch (err: unknown) {
      const errorMessage: string = err instanceof Error ? err.message : String(err);
      this.error.set(errorMessage);
      this.tables.set([]);
    } finally {
      this.isLoading.set(false);
    }
  }

  private async _queryTableAsync(): Promise<void> {
    const dbName: string | null = this.selectedDatabase();
    const tableName: string | null = this.selectedTable();

    if (!dbName || !tableName) {
      return;
    }

    this.isLoading.set(true);
    this.error.set(null);

    try {
      const result: IQueryDatabaseResult = await this._socket.queryDatabaseAsync(
        "query_table",
        dbName,
        tableName,
        {
          where: this.whereClause() || undefined,
          orderBy: this.orderByClause() || undefined,
          limit: this.limitValue(),
        },
      );

      if (result.success && result.rows) {
        this.rows.set(result.rows);
        this.totalCount.set(result.totalCount ?? result.rows.length);
        this.returnedCount.set(result.returnedCount ?? result.rows.length);
      } else {
        this.error.set(result.error ?? "Failed to query table");
        this.rows.set([]);
        this.totalCount.set(0);
        this.returnedCount.set(0);
      }
    } catch (err: unknown) {
      const errorMessage: string = err instanceof Error ? err.message : String(err);
      this.error.set(errorMessage);
      this.rows.set([]);
      this.totalCount.set(0);
      this.returnedCount.set(0);
    } finally {
      this.isLoading.set(false);
    }
  }

  //#endregion Private methods
}
