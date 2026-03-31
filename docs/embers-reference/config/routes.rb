#require 'sidekiq/web'

Rails.application.routes.draw do

  #mount TryApi::Engine => '/developers'
  #mount Sidekiq::Web, at: '/sidekiq' ##pede ligação Redis (?)

  match 'api/*all' => 'api/base#cors_preflight_check', :constraints => {:method => 'OPTIONS'}, :via => [:options]

  root to: 'pages#index' ### pages/index.html.slim

  match 'admin/expenses/add_expense', to: Admin::ExpensesController.action(:add_expense), via: :post
  match 'admin/users/stats', to: Admin::UsersController.action(:stats), via: :get
  match 'admin/assets/stats', to: Admin::AssetsController.action(:stats), via: :get
  match 'admin/assets/my_assets', to: Admin::AssetsController.action(:my_assets), via: :get
  match 'admin/assets/get_eur_value', to: Admin::AssetsController.action(:get_eur_value), via: :get
  match 'admin/assets/update_stocks', to: Admin::AssetsController.action(:update_stocks), via: :post

  scope '(:locale)' do
    resources :attachments, only: [:destroy] do
      collection do
        post '/:entity_type', to: 'attachments#create'
      end
    end

    namespace :admin do
      resources :admins, only: %i[index create update destroy show]
      resources :students do
        collection do
          get 'autocomplete'
          get 'autocomplete_class'
          post 'update_class_year'
        end
      end
      resources :real_state_zones do
        collection do
          get 'autocomplete_marketplace'
        end
      end
      resources :properties
      resources :users, only: %i[index create update show] do
        collection do
          # get :total_net_value
        end
      end

      resources :categories, only: %i[index create update destroy show]
      
      resources :evolutions, only: [:index, :show, :create, :update, :destroy]

      resources :assets, only: %i[index create update destroy show] do
        collection do
          post '/get_balances/:id', to: 'assets#get_balances'
          post '/get_balance_addr/:id/:addr_id', to: 'assets#get_balance_addr'
          post '/update_value/:asset_id', action: :update_value
          post '/update_all_values', action: :update_all_values
          post '/sum_balances/:id', to: 'assets#sum_balances'
          post '/total_value/:id', to: 'assets#total_value'
          post :save_calculator_state
          get '/total_rent/:id', to: 'assets#total_rent'
          get '/stocks', action: :stocks
        end
        member do
          put 'undestroy'
        end
      end
      resources :addresses, only: %i[index create destroy update show] do
        collection do
          post 'generate_bitcoin_address'
          post 'invest_in_stock'
        end
      end
      resources :organizations, only: %i[index create update destroy show] do
        member do
          put 'undestroy'
        end
      end

      resources :expenses, only: %i[index create destroy update show] do
        collection do
          get 'autocomplete_card'
          get 'autocomplete_entity'
          get 'autocomplete_category'
          get 'monthly_expenses'
          get 'get_user_savings_score'
        end
      end

      resources :sessions, only: :create do
        collection do
          delete :destroy
          get :check
        end
      end

      # Nova rota para cp_schedules:
      resources :cp_schedules, only: %i[index create update destroy show] do
        member do
          put :retry
          post :test_pass
          delete :destroy_ticket   # /admin/cp_schedules/:id/destroy_ticket
        end
      end

    end

    namespace :api do
      namespace :v1 do
        resources :sessions, only: :create do
          collection do
            delete :destroy
            get :check
            post :update_token
          end
        end

        resources :users, only: %i[create show] do
          collection do
            put :change_password
            get :show_profile
            get :total_net_value
            get :total_rent
            get :get_user_apr
            post :user_activity_status
            get :total_expenses
            get :net_distribution
            get :portfolio
          end
        end

      end
    end
  end
end
