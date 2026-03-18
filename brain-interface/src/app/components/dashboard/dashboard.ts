import { Component, ChangeDetectionStrategy, inject, OnInit, signal } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { TerminalComponent } from "../terminal/terminal";
import { GraphComponent } from "../graph/graph";
import { LogsComponent } from "../logs/logs";
import { DatabaseComponent } from "../database/database";
import { BrainSocketService } from "../../services/brain-socket.service";
import type { IScheduleTask } from "../../models/brain.types";

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

@Component({
  selector: "app-dashboard",
  standalone: true,
  imports: [CommonModule, FormsModule, TerminalComponent, GraphComponent, LogsComponent, DatabaseComponent],
  templateUrl: "./dashboard.html",
  styleUrl: "./dashboard.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardComponent implements OnInit {
  private _socket = inject(BrainSocketService);

  protected readonly connected = this._socket.connected;
  protected readonly currentChatId = this._socket.currentChatId;
  protected readonly authError = this._socket.authError;

  protected chatIdInput = signal("");
  protected authTokenInput = signal("");
  protected showStartDialog = signal(false);
  protected activeTab: "chat" | "schedules" | "logs" | "database" = "chat";
  protected schedules = signal<IScheduleTask[]>([]);

  public ngOnInit(): void {
    this.authTokenInput.set(this._socket.getAuthToken());
    const wsUrl = `http://${window.location.hostname}:3001`;
    this._socket.connect(wsUrl, this.authTokenInput());
    // Once connected, auto-start or re-use an existing chat session
    this._socket.onConnectedAsync().then(async () => {
      const existingId = this.currentChatId();
      const chatId = existingId ?? generateId();
      await this._socket.startConversationAsync(chatId);
    });
  }

  protected onStartConversation(): void {
    const chatId = this.chatIdInput().trim() || generateId();
    this._socket.startConversationAsync(chatId);
    this.showStartDialog.set(false);
    this.chatIdInput.set("");
  }

  protected onSaveTokenAndReconnect(): void {
    this._socket.setAuthToken(this.authTokenInput());
    const wsUrl: string = `http://${window.location.hostname}:3001`;
    this._socket.connect(wsUrl, this.authTokenInput());
  }

  protected async onSendMessage(message: string): Promise<void> {
    await this._socket.sendMessageAsync(message);
  }

  protected clearEvents(): void {
    this._socket.clearEvents();
  }

  protected async onFactoryResetAsync(): Promise<void> {
    await this._socket.factoryResetAsync();
  }

  protected async onPauseAsync(): Promise<void> {
    await this._socket.pauseAsync();
  }

  protected async onResumeAsync(): Promise<void> {
    await this._socket.resumeAsync();
  }

  protected async onStopAsync(): Promise<void> {
    await this._socket.stopAsync();
  }

  protected async loadSchedulesAsync(): Promise<void> {
    const list: IScheduleTask[] = await this._socket.listSchedulesAsync();
    this.schedules.set(list);
  }

  protected async toggleScheduleAsync(task: IScheduleTask): Promise<void> {
    await this._socket.toggleScheduleAsync(task.taskId, !task.enabled);
    await this.loadSchedulesAsync();
  }

  protected onTabChange(tab: "chat" | "schedules" | "logs" | "database"): void {
    this.activeTab = tab;
    if (tab === "schedules") {
      this.loadSchedulesAsync();
    }
  }
}
