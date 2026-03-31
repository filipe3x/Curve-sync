class Admin::ExpensesController < Admin::BaseController
  #Estas ações ignoram a verificação de 'admin' e 'autenticação'
  skip_before_action :only_admins, :authenticate_user, only: %i[index, add_expense]
  #skip_before_action :only_admins, only: %i[get_balances, get_balance_addr, stats]

  def index
    expenses = current_user.expenses.search_query(params)
    total_amount = expenses.sum(:amount)
    render json: { 
      expenses: expenses.map(&:to_json), 
      total: total_amount, 
      score: savings_score(weekly_expenses)
    }
  end

  def create
    expense = Expense.new(expense_params)
    expense.user = current_user
    if expense.save
      current_user.expenses << expense
      render json: { id: expense.id.to_s }
    else
      render json: { errors: expense.errors.full_messages }, status: :unprocessable_entity
    end
  end

  def add_expense
    expense = Expense.new(expense_params)
    expense.user = User.find_by(id: params[:user_id])
    if expense.save
      expense.user.expenses << expense
      render json: { id: expense.id.to_s }
    else
      render json: { errors: expense.errors.full_messages }, status: :unprocessable_entity
    end
  end

  def update
    expense = Expense.find_by(id: params[:id], user_id: current_user.id)
    
    unless expense
      render json: { errors: ['Expense not found'] }, status: :not_found
      return
    end
    
    if expense_params[:category].present?
      category = Category.find_by(name: expense_params[:category])
      if category
        expense.category = category
      else
        # Handle the case where the category is not found
        render json: { errors: ['Category not found'] }, status: :unprocessable_entity
        return
      end
    end
    
    if expense.update(expense_params.except(:category))
      render json: { message: 'Expense successfully updated.', expense: expense.to_json }
    else
      render json: { errors: expense.errors.full_messages }, status: :unprocessable_entity
    end
  end

  def destroy
    expense = Expense.find_by(id: params[:id], user_id: current_user.id)
    if expense
      if expense.destroy
        render json: { message: 'Expense deleted.' }
      else
        render json: { errors: expense.errors.full_messages }, status: :unprocessable_entity
      end
    else
      render json: { errors: ['Expense not found.'] }, status: :not_found
    end
  end
  
  def show
    expense = Expense.find_by id: params[:id], user_id: current_user.id
    if expense
      render json: { expense: expense.to_json }
    else
      render json: { errors: expense.errors.full_messages }, status: :unprocessable_entity
    end
  end

  def autocomplete_card
    term = params[:term]&.downcase
    cards = Expense.where(card: /#{Regexp.escape(term)}/i).pluck(:card).uniq
    render json: cards
  end

  def autocomplete_entity
    term = params[:term]&.downcase
    entities = Expense.where(entity: /#{Regexp.escape(term)}/i).pluck(:entity).uniq
    render json: entities
  end

  def autocomplete_category
    term = params[:term]&.downcase
    categories = Category.where(name: /#{Regexp.escape(term)}/i).pluck(:name).uniq
    render json: categories
  end

  def monthly_expenses
    params[:start_date] ||= (Date.today - 1.year).beginning_of_month.strftime('%Y-%m-%d')
    params[:end_date] ||= Date.today.end_of_month.strftime('%Y-%m-%d')

    current_month = Date.today.beginning_of_month # - 1 ?

    # Initialize an array to store the previous 12 months
    previous_months = []

    # Loop through the previous 12 months
    12.times do |i|
      month = current_month - i.months
      previous_months << {
        month_start: Date.new(month.year, month.month, 22),
        month: month.strftime("%B %Y"),
        total: 0.0,
      }
    end
    
    expenses = Expense.search_all(params)

    # Group expenses by the custom start of each month
    expenses_by_month = expenses.group_by { |expense| expense.my_month_start }
      .sort_by { |month_start, _| month_start }
      .map do |month_start, expenses|
      {
        month_start: month_start,
        month: month_start.strftime("%B %Y"),
        total: expenses.sum(&:amount)
      }
    end

    # Merge the previous months with the expenses by month
    result = previous_months.map do |prev_month|
      month_start = prev_month[:month_start]
      month = prev_month[:month]
      total = expenses_by_month.find { |expense_month| expense_month[:month_start] == month_start }&.[](:total) || 0.0
      {
        month_start: month_start,
        month: month,
        total: total,
        percentage_increase: prev_month[:total].zero? ? 0 : (total.to_f / prev_month[:total] - 1) * 100
      }
    end

    # Sort the result by year and month in descending order
    result = result.sort_by { |h| [h[:month_start].year, h[:month_start].month] }

    # Calculate percentage increases
    expenses_with_percentage = result.each_with_index.map do |current, index|
      if current[:total].zero? || (index > 0 && result[index - 1][:total].zero?)
        current.merge(percentage_increase: 0)
      elsif index == 0
        current.merge(percentage_increase: 0)
      else
        previous = result[index - 1]
        percentage_increase = ((current[:total] - previous[:total]) / previous[:total]) * 100.0
        current.merge(percentage_increase: percentage_increase.round(2))
      end
    end

    render json: expenses_with_percentage
  end

  def savings_score(weekly_spendings)
    monthly_budget = 295.0 # hardcoded for now
    weekly_budget = monthly_budget / 4.0
  
    weekly_savings = weekly_budget - weekly_spendings
  
    if weekly_savings > 0
      # Calculate score using a more refined logarithmic function
      score = (Math.log(weekly_savings + 1) / Math.log(weekly_budget + 1)) * 10
    elsif weekly_savings < 0
      # Overspending, score 0
      score = 0
    else
      # Exactly on budget, score 5
      score = 5
    end
  
    # Ensure the score is within 0-10 range
    score = [[score, 10].min, 0].max
  
    # Round score to nearest integer
    score.round
  end
  

  def weekly_expenses
    start_date = Date.today.beginning_of_week
    end_date = Date.today.end_of_week
  
    expenses = Expense.where(date: start_date..end_date)
  
    total_expenses = expenses.sum(&:amount)
  
    total_expenses
  end

  def get_user_savings_score  
    savings_score = savings_score(weekly_expenses)
  
    render json: { 
      savings_score: savings_score, 
      week_expenses: weekly_expenses, 
      remaining_this_week: (295 / 4) - weekly_expenses 
    }
  end

  private

  def expense_params
    params.permit(:entity, :amount, :date, :card, :digest, :user_id, :show_all, :category)
  end
end
