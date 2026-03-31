# CLAUDE.md - Embers Platform

## Overview

Embers is a personal finance and asset management platform built with Ruby on Rails (backend) and React/Redux (frontend), using MongoDB as the database. It includes auxiliary Python scripts for web scraping, stock data retrieval, and transport automation.

## Tech Stack

### Backend
- **Ruby on Rails 5.0.1** - Web framework (MVC)
- **MongoDB** via **Mongoid 6.1** (ODM) - NoSQL document database
- **Puma** - Application server
- **Slim** - Template engine for views
- **CanCanCan** - Authorization/permissions
- **Paperclip** (with mongoid-paperclip) - File/image uploads
- **Figaro** - Environment variable and secret key management
- **FCM** - Firebase Cloud Messaging for push notifications
- **Whenever** - Cron job scheduling (rake tasks)
- **Geocoder + Mongoid Geospatial** - Geolocation and geospatial queries
- **REST Client** - HTTP requests to external APIs
- **bitcoin-ruby** - Bitcoin address generation and operations
- **i18n-js** - Client-side internationalization
- **Will Paginate** - Pagination
- **Try API** - API endpoint testing/documentation

### Frontend
- **React 15** with **Redux** - UI components and state management
- **React Router** - Client-side routing
- **Browserify** (via browserify-rails) - JavaScript module bundling
- **Babel** (ES2015, React, Stage-0) - JavaScript transpilation
- **Bootstrap 3** + **react-bootstrap** - CSS framework
- **Font Awesome** - Icons
- **Material UI** - Material Design components
- **Recharts** - Charts and data visualization
- **Froala Editor** - Rich text WYSIWYG editor
- **Moment.js** - Date manipulation
- **js-cookie** - Cookie management
- **react-dropzone** - File upload drag & drop
- **Vanilla Tilt** - 3D tilt effect
- **SCSS** (sass-rails) + **Autoprefixer** - Stylesheets with cross-browser support

### Python Scripts
- **yfinance** - Stock market data retrieval (`yfinance/get_stocks.py`)
- **BeautifulSoup4 + Requests** - Web scraping (idealista, CP)
- **Selenium/Requests** - Transport automation (CP train reservations and pass validation)
- **Twilio** - SMS notifications (idealista alerts)
- **Pandas/NumPy** - Data processing (stocks)

### Testing
- **Mocha** - JavaScript testing
- **Byebug** - Ruby debugger

## Project Structure

```
embers/
├── app/
│   ├── assets/javascripts/
│   │   └── app/                  # React/Redux frontend
│   │       ├── actions/          # Redux actions
│   │       ├── components/       # React components (by feature)
│   │       │   ├── assets/       # Asset management UI
│   │       │   ├── expenses/     # Expense tracking UI
│   │       │   ├── portfolio/    # Portfolio visualization
│   │       │   ├── calculator/   # Financial calculator
│   │       │   ├── organizations/# Organization management
│   │       │   ├── students/     # Student management
│   │       │   ├── users/        # User management
│   │       │   ├── addresses/    # Crypto address management
│   │       │   ├── categories/   # Expense categories
│   │       │   ├── evolutions/   # Asset evolution tracking
│   │       │   ├── cp_schedules/ # Train schedule management
│   │       │   ├── real_state_zones/ # Real estate zones
│   │       │   ├── real_state_listings/ # Property listings
│   │       │   ├── curve/        # Curve/chart visualization
│   │       │   ├── coin_card/    # Cryptocurrency card
│   │       │   ├── common/       # Shared components
│   │       │   ├── layouts/      # Layout components
│   │       │   └── pages/        # Page-level components
│   │       ├── reducers/         # Redux reducers
│   │       ├── services/         # API service layer (HTTP calls)
│   │       └── create_store.js   # Redux store configuration
│   ├── controllers/
│   │   ├── admin/                # Admin panel controllers
│   │   │   ├── assets_controller.rb
│   │   │   ├── expenses_controller.rb
│   │   │   ├── users_controller.rb
│   │   │   ├── addresses_controller.rb
│   │   │   ├── categories_controller.rb
│   │   │   ├── evolutions_controller.rb
│   │   │   ├── organizations_controller.rb
│   │   │   ├── properties_controller.rb
│   │   │   ├── real_state_zones_controller.rb
│   │   │   ├── students_controller.rb
│   │   │   ├── cp_schedules_controller.rb
│   │   │   └── sessions_controller.rb
│   │   ├── api/v1/               # REST API v1
│   │   │   ├── sessions_controller.rb
│   │   │   └── users_controller.rb
│   │   └── pages_controller.rb   # SPA entry point
│   ├── models/                   # Mongoid models
│   │   ├── user.rb               # Users (roles: admin, user)
│   │   ├── asset.rb              # Financial assets (crypto, stocks, etc.)
│   │   ├── address.rb            # Crypto wallet addresses
│   │   ├── expense.rb            # Expense records
│   │   ├── category.rb           # Expense categories
│   │   ├── evolution.rb          # Asset value history over time
│   │   ├── organization.rb       # Organizations
│   │   ├── property.rb           # Real estate properties
│   │   ├── real_state_zone.rb    # Real estate zones
│   │   ├── student.rb            # Students
│   │   ├── cp_schedule.rb        # Train schedules (CP)
│   │   ├── goal.rb               # Financial goals
│   │   └── session.rb            # User sessions
│   ├── services/
│   │   └── pass_validator.rb     # CP train pass validation service
│   ├── views/
│   │   ├── pages/                # SPA entry view (Slim)
│   │   ├── admin/                # Admin views
│   │   └── layouts/              # Layout templates
│   ├── jobs/                     # Background jobs
│   └── mailers/                  # Email mailers
├── config/
│   ├── routes.rb                 # All application routes
│   ├── mongoid.yml_example       # MongoDB connection config
│   ├── application.yml_example   # Environment variables (Figaro)
│   ├── schedule.rb               # Cron jobs (Whenever)
│   └── locales/                  # i18n translations
├── lib/tasks/                    # Rake tasks
│   ├── evolution.rake            # Daily asset evolution snapshots
│   ├── reservation.rake          # CP train reservation automation
│   ├── generate_real_state_zone_urls.rake
│   └── rsa.rake                  # RSA key operations
├── yfinance/
│   └── get_stocks.py             # Stock price fetcher (Yahoo Finance)
├── curve.py                      # Expense parsing from email (Curve card)
├── idealista.py                  # Real estate scraper (Idealista.pt)
├── reservar-lugar.py             # CP train seat reservation bot
├── testar-passe.py               # CP train pass validator
├── add_expense.sh                # Quick expense creation script
└── db/seeds.rb                   # Database seed data
```

## Main Features

### 1. Asset & Portfolio Management
- Track crypto, stocks, and other financial assets
- Bitcoin address generation and balance tracking via blockchain APIs
- Stock portfolio with Yahoo Finance integration (`yfinance/get_stocks.py`)
- Asset value updates via external APIs (price + balance)
- Portfolio distribution visualization (pie charts via Recharts)
- Total net value calculation and APR tracking
- Financial calculator

### 2. Expense Tracking
- Record and categorize expenses (entity, amount, date, card)
- Automatic category assignment
- Monthly expense reports and savings score
- Curve card email parsing (`curve.py`) to auto-import expenses
- Autocomplete for cards, entities, and categories

### 3. Evolution History
- Daily snapshots of asset values (cron job: `evolution.rake`)
- Historical value tracking per user per asset
- Trend analysis and visualization

### 4. Real Estate
- Idealista.pt web scraper (`idealista.py`) with SMS alerts via Twilio
- Real estate zone management with geospatial data
- Property listings tracking

### 5. CP Train Automation
- Train schedule management and seat reservation (`reservar-lugar.py`)
- Automated pass validation (`testar-passe.py` + `PassValidator` service)
- Reservation execution via cron (every minute)

### 6. User Management
- Authentication with encrypted passwords and sessions
- Role-based access (admin/user) via CanCanCan
- Avatar upload
- Activity tracking
- API v1 with token-based sessions

### 7. Student Management
- Student records with autocomplete
- Class year management

### 8. Organization Management
- CRUD with soft delete (undestroy)

## API Structure

### Admin Routes (`/admin/`)
Full CRUD for all entities (assets, expenses, users, categories, evolutions, organizations, students, properties, real_state_zones, cp_schedules, addresses, sessions).

### API v1 Routes (`/api/v1/`)
- Sessions: create, destroy, check, update_token
- Users: create, show_profile, change_password, total_net_value, total_rent, get_user_apr, total_expenses, net_distribution, portfolio

## Configuration

- **Database**: MongoDB (config in `config/mongoid.yml_example`)
- **Environment variables**: Managed via Figaro (`config/application.yml_example`)
- **Secrets**: `config/secrets.yml_example`
- **Cron**: Configured in `config/schedule.rb` (Whenever gem)
- **CORS**: Handled in API base controller

## Running the Application

```bash
bundle install          # Install Ruby dependencies
npm install             # Install JavaScript dependencies
rails s                 # Start Rails server (Puma)
```

## Key Commands

```bash
rails c                           # Rails console
rake evolution:create             # Create daily evolution snapshots
rake reservation:execute          # Execute pending train reservations
python3 yfinance/get_stocks.py    # Fetch stock prices
python3 idealista.py              # Run real estate scraper
python3 curve.py                  # Parse Curve card email expenses
```

## Detailed Documentation

- [Expense Tracking & Curve Email Parsing](docs/expense-tracking.md) - Detailed documentation on the expense tracking system, categories, savings score, and automatic Curve card email parsing
