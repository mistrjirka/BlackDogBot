import { Component, ChangeDetectionStrategy, inject, OnInit, OnDestroy } from "@angular/core";
import { CommonModule } from "@angular/common";
import { BrainSocketService } from "../../services/brain-socket.service";
import type { ILogEntryEvent } from "../../models/brain.types";

@Component({
  selector: "app-logs",
  standalone: true,
  imports: [CommonModule],
  templateUrl: "./logs.html",
  styleUrl: "./logs.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogsComponent implements OnInit, OnDestroy {
  private _socket = inject(BrainSocketService);

  protected readonly logs = this._socket.logs;

  public ngOnInit(): void {
    this._socket.subscribeLogsAsync();
  }

  public ngOnDestroy(): void {
    this._socket.unsubscribeLogsAsync();
  }

  protected trackByTimestamp(_index: number, entry: ILogEntryEvent): string {
    return entry.timestamp;
  }
}
