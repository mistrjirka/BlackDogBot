import { Component, ChangeDetectionStrategy } from "@angular/core";
import { DashboardComponent } from "./components/dashboard/dashboard";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [DashboardComponent],
  template: `<app-dashboard />`,
  styles: [`
    :host {
      display: block;
      height: 100vh;
      width: 100vw;
      margin: 0;
      padding: 0;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {}