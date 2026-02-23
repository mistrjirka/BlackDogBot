import { Component, input, output, ChangeDetectionStrategy, inject, signal } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import type { TerminalEntry, BrainEventType } from "../../models/brain.types";
import { BrainSocketService } from "../../services/brain-socket.service";

@Component({
  selector: "app-terminal",
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: "./terminal.html",
  styleUrl: "./terminal.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TerminalComponent {
  private _socket = inject(BrainSocketService);

  public connected = input<boolean>(false);
  public messageSend = output<string>();

  protected readonly events = this._socket.events;
  protected readonly currentChatId = this._socket.currentChatId;

  protected messageText = signal("");
  protected autoScroll = signal(true);

  protected getEventIcon(type: BrainEventType | "user_message"): string {
    const icons: Record<string, string> = {
      step_started: "▶",
      tool_called: "🔧",
      tool_result: "📤",
      model_output: "💬",
      graph_updated: "📊",
      conversation_started: "🚀",
      conversation_ended: "✅",
      agent_paused: "⏸",
      agent_resumed: "▶",
      agent_stopped: "⏹",
      error: "❌",
      job_execution_started: "⚙️",
      job_execution_completed: "✅",
      job_execution_failed: "❌",
      log_entry: "📋",
      status_update: "🔄",
      user_message: "🧑",
    };
    return icons[type] ?? "•";
  }

  protected getEventClass(type: BrainEventType): string {
    return `event-${type.replace(/_/g, "-")}`;
  }

  protected formatTimestamp(date: Date): string {
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  protected formatData(data: unknown): string {
    if (typeof data === "object" && data !== null) {
      return JSON.stringify(data, null, 2);
    }
    return String(data);
  }

  protected async onSendMessage(): Promise<void> {
    const message = this.messageText().trim();
    if (!message) {
      return;
    }

    this._socket.addUserMessage(message);
    this.messageSend.emit(message);
    this.messageText.set("");
  }

  protected onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void this.onSendMessage();
    }
  }

  protected scrollToBottom(element: HTMLElement): void {
    if (this.autoScroll()) {
      element.scrollTop = element.scrollHeight;
    }
  }
}
