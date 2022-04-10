import { FocusKeyManager } from '@angular/cdk/a11y';
import { Component, Output, TemplateRef, ViewChild, EventEmitter, ContentChildren, QueryList, HostListener, AfterContentInit } from "@angular/core";
import { MenuItemComponent } from './menu-item.component';

@Component({
  selector: "bit-menu",
  templateUrl: "./menu.component.html",
})
export class MenuComponent implements AfterContentInit {
  @ViewChild(TemplateRef) templateRef: TemplateRef<any>;
  @Output() closed = new EventEmitter<void>();
  @ContentChildren(MenuItemComponent) menuItems: QueryList<MenuItemComponent>;
  keyManager: FocusKeyManager<MenuItemComponent>;

  ngAfterContentInit() {
    this.keyManager = new FocusKeyManager(this.menuItems).withWrap();
  }
}